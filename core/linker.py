"""
Core Linker Module

Integrates all components to provide high-level API for model linking.
"""

import os
import re
import json
from typing import Dict, Any, List, Optional, Tuple
from urllib.parse import unquote

from .log_system.log_funcs import (
    log_debug,
    log_info,
    log_warn,
    log_error,
    log_exception,
)
from .scanner import get_model_files
from .workflow_analyzer import analyze_workflow_models, identify_missing_models
from .matcher import find_matches
from .workflow_updater import update_workflow_nodes
from .sources.civitai import resolve_urn

# Regex patterns for URL extraction (matches HuggingFace and CivitAI URLs)
URL_PATTERN = re.compile(r'(https?://(?:huggingface\.co|civitai\.com)[^\s"\'<>\)\\]+)')

# Model file extensions to look for
MODEL_EXTENSIONS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".onnx", ".gguf")


def search_local_matches(
    target_for_matching: str,
    category: Optional[str] = None,
    similarity_threshold: float = 0.0,
    max_matches_per_model: int = 10,
) -> List[Dict[str, Any]]:
    """
    Search local model files using the same matcher as workflow analysis.

    Args:
        target_for_matching: Filename/path to match against local files
        category: Optional category hint to prioritize/filter candidates
        similarity_threshold: Minimum similarity score (0.0 to 1.0)
        max_matches_per_model: Maximum number of matches to return

    Returns:
        Deduplicated list of local matches sorted by similarity
    """
    available_models = get_model_files()

    candidates = available_models
    if category and category != "unknown":
        candidates = [m for m in available_models if m.get("category") == category]
        candidates.extend(
            [m for m in available_models if m.get("category") != category]
        )

    matches = find_matches(
        target_for_matching,
        candidates,
        threshold=similarity_threshold,
        max_results=max_matches_per_model,
    )

    seen_absolute_paths = {}
    deduplicated_matches = []
    for match in matches:
        model_dict = match["model"]
        absolute_path = model_dict.get("path", "")
        if absolute_path:
            absolute_path = os.path.normpath(absolute_path)

        if absolute_path not in seen_absolute_paths:
            seen_absolute_paths[absolute_path] = match
            deduplicated_matches.append(match)
        else:
            existing_match = seen_absolute_paths[absolute_path]
            if match["confidence"] > existing_match["confidence"]:
                idx = deduplicated_matches.index(existing_match)
                deduplicated_matches[idx] = match
                seen_absolute_paths[absolute_path] = match

    return deduplicated_matches


def extract_workflow_urls(workflow_json: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """
    Extract model URLs from workflow JSON.

    Sources:
    1. node.properties.models array - contains {name, url, directory}
    2. Regex extraction from workflow JSON string - finds HuggingFace/CivitAI URLs

    Args:
        workflow_json: Complete workflow JSON dictionary

    Returns:
        Dict mapping model filename -> {url, directory, source}
    """
    url_map = {}

    # Convert to string for regex search
    workflow_str = json.dumps(workflow_json)

    # Collect all nodes including from subgraphs
    all_nodes = list(workflow_json.get("nodes", []))
    definitions = workflow_json.get("definitions", {})
    subgraphs = definitions.get("subgraphs", [])
    for subgraph in subgraphs:
        subgraph_nodes = subgraph.get("nodes", [])
        all_nodes.extend(subgraph_nodes)

    # 1. Extract from node.properties.models (authoritative source)
    for node in all_nodes:
        node_type = node.get("type", "")
        properties = node.get("properties", {})
        models_list = properties.get("models", [])

        for model_info in models_list:
            if isinstance(model_info, dict):
                name = model_info.get("name", "")
                url = model_info.get("url", "")
                directory = model_info.get("directory", "")

                if name and name not in url_map:
                    url_map[name] = {
                        "url": url,
                        "directory": directory,
                        "node_type": node_type,
                        "source": "node_properties",
                    }

    # 2. Extract URLs via regex from workflow JSON
    urls_found = URL_PATTERN.findall(workflow_str)

    # Clean URLs (remove trailing characters that may have been captured)
    cleaned_urls = []
    for url in urls_found:
        url = url.split(")")[0].replace("\\n", "").replace("\n", "").strip()
        if url:
            cleaned_urls.append(url)

    # 3. Extract model filenames via regex
    model_pattern = re.compile(
        r"([\w\-\.%]+\.(?:safetensors|ckpt|pt|pth|bin|onnx|gguf))", re.IGNORECASE
    )
    model_files_raw = model_pattern.findall(workflow_str)

    # Clean and decode filenames
    model_files = set()
    model_name_map = {}  # decoded -> original

    for model in model_files_raw:
        cleaned = model.strip()
        if cleaned and cleaned[0].isalnum():
            try:
                decoded = unquote(cleaned)
            except Exception:
                decoded = cleaned
            model_files.add(decoded)
            model_name_map[decoded] = cleaned

    # 4. Match URLs to model filenames
    for model in model_files:
        # Skip if already found in node.properties.models
        if model in url_map and url_map[model].get("url"):
            continue

        original_name = model_name_map.get(model, model)

        for url in cleaned_urls:
            # Check decoded name in URL
            if model in url:
                if model not in url_map:
                    url_map[model] = {"url": url, "directory": "", "source": "regex"}
                elif not url_map[model].get("url"):
                    url_map[model]["url"] = url
                    url_map[model]["source"] = "regex"
                break
            # Check original (possibly URL-encoded) name in URL
            if original_name in url:
                if model not in url_map:
                    url_map[model] = {"url": url, "directory": "", "source": "regex"}
                elif not url_map[model].get("url"):
                    url_map[model]["url"] = url
                    url_map[model]["source"] = "regex"
                break
            # Check without extension
            model_base = os.path.splitext(model)[0]
            if model_base in url or unquote(model_base) in url:
                if model not in url_map:
                    url_map[model] = {"url": url, "directory": "", "source": "regex"}
                elif not url_map[model].get("url"):
                    url_map[model]["url"] = url
                    url_map[model]["source"] = "regex"
                break

    return url_map


def parse_huggingface_url(url: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Extract HuggingFace repo and path from URL.

    Args:
        url: HuggingFace URL

    Returns:
        Tuple of (repo_id, file_path) or (None, None) if not valid
    """
    if not url or "huggingface.co" not in url:
        return None, None

    # Pattern: https://huggingface.co/user/repo/resolve/main/path/to/file.safetensors
    match = re.match(
        r"https?://huggingface\.co/([^/]+/[^/]+)/(?:resolve|blob)/[^/]+/(.+)", url
    )
    if match:
        return match.group(1), match.group(2)

    return None, None


def analyze_and_find_matches(
    workflow_json: Dict[str, Any],
    similarity_threshold: float = 0.0,
    max_matches_per_model: int = 10,
) -> Dict[str, Any]:
    """
    Main entry point: analyze workflow and find matches for missing models.

    Args:
        workflow_json: Complete workflow JSON dictionary
        similarity_threshold: Minimum similarity score (0.0 to 1.0) for matches
        max_matches_per_model: Maximum number of matches to return per missing model

    Returns:
        Dictionary with analysis results:
        {
            'missing_models': [
                {
                    'node_id': node ID,
                    'node_type': node type,
                    'widget_index': widget index,
                    'original_path': original path from workflow,
                    'category': model category,
                    'workflow_url': URL from workflow if found,
                    'workflow_directory': directory from workflow if found,
                    'matches': [
                        {
                            'model': model dict from scanner,
                            'filename': model filename,
                            'similarity': similarity score (0.0-1.0),
                            'confidence': confidence percentage (0-100)
                        },
                        ...
                    ]
                },
                ...
            ],
            'total_missing': count of missing models,
            'total_models_analyzed': count of all models in workflow
        }
    """
    # Extract URLs from workflow (node.properties.models + regex)
    workflow_urls = extract_workflow_urls(workflow_json)
    log_debug(f"Extracted {len(workflow_urls)} URLs from workflow")

    # Analyze workflow to find all model references
    # Get available models
    available_models = get_model_files()
    available_models_by_category = {}
    for model in available_models:
        model_category = model.get("category", "")
        if model_category not in available_models_by_category:
            available_models_by_category[model_category] = []
        available_models_by_category[model_category].append(model)

    ordered_candidates_cache: Dict[str, List[Dict[str, Any]]] = {}

    # Analyze workflow using the same already-scanned model list
    all_model_refs = analyze_workflow_models(
        workflow_json, available_models=available_models
    )

    # Identify missing models
    missing_models = identify_missing_models(all_model_refs, available_models)

    # Enrich missing models with workflow URLs
    for missing in missing_models:
        original_path = missing.get("original_path", "")
        filename = os.path.basename(original_path)

        if filename in workflow_urls:
            url_info = workflow_urls[filename]
            missing["workflow_url"] = url_info.get("url", "")
            missing["workflow_directory"] = url_info.get("directory", "")
            missing["url_source"] = url_info.get("source", "")

    # Handle URNs: mark for async resolution by frontend
    # No sync CivitAI calls here - frontend will fetch asynchronously
    for missing in missing_models:
        if missing.get("is_urn"):
            missing["needs_urn_resolve"] = True
            urn = missing.get("urn")
            if urn:
                missing["urn_model_id"] = urn.get("model_id")
                missing["urn_version_id"] = urn.get("version_id")
                missing["urn_type"] = urn.get("type", "")

    # Find matches for each missing model
    missing_with_matches = []
    for missing in missing_models:
        # Skip LoraManager lorAs that already exist locally (exists=True means no linking needed)
        is_lora_v2 = missing.get("is_lora_v2")
        exists = missing.get("exists")
        name = missing.get("name") or missing.get("original_path", "")
        log_debug(f"Checking {name}: is_lora_v2={is_lora_v2}, exists={exists}")

        if is_lora_v2 and exists:
            log_info(f"Skipping LoraManager lora {name} - already exists locally")
            continue

        target_for_matching = missing.get("original_path", "")

        # For URNs, prefer expected_filename for matching
        if missing.get("is_urn") and missing.get("expected_filename"):
            target_for_matching = missing["expected_filename"]
        elif isinstance(target_for_matching, str) and target_for_matching.startswith(
            "urn:air:"
        ):
            # Don't fuzzy-match the full URN string against every local model.
            # For worker-asset style URNs, try using the filename-like suffix after "@";
            # otherwise skip local matching until the frontend resolves the URN async.
            urn_suffix = target_for_matching.split("@", 1)[1] if "@" in target_for_matching else ""
            urn_suffix_ext = os.path.splitext(urn_suffix)[1].lower()
            if urn_suffix and urn_suffix_ext in MODEL_EXTENSIONS:
                target_for_matching = urn_suffix
            else:
                missing_with_matches.append({**missing, "matches": []})
                continue

        # Filter available models by category if known
        category = missing.get("category")
        if not category or category == "unknown":
            from .workflow_analyzer import NODE_TYPE_TO_CATEGORY_HINTS

            node_type = missing.get("node_type", "")
            category = NODE_TYPE_TO_CATEGORY_HINTS.get(node_type, "unknown")

        candidates = available_models
        if category and category != "unknown":
            candidates = ordered_candidates_cache.get(category)
            if candidates is None:
                preferred = available_models_by_category.get(category, [])
                others = [
                    m for m in available_models if m.get("category") != category
                ]
                candidates = preferred + others
                ordered_candidates_cache[category] = candidates

        # Find matches
        matches = find_matches(
            target_for_matching,
            candidates,
            threshold=similarity_threshold,
            max_results=max_matches_per_model,
        )

        # Deduplicate matches by absolute path
        seen_absolute_paths = {}
        deduplicated_matches = []
        for match in matches:
            model_dict = match["model"]
            absolute_path = model_dict.get("path", "")
            if absolute_path:
                absolute_path = os.path.normpath(absolute_path)

            if absolute_path not in seen_absolute_paths:
                seen_absolute_paths[absolute_path] = match
                deduplicated_matches.append(match)
            else:
                existing_match = seen_absolute_paths[absolute_path]
                if match["confidence"] > existing_match["confidence"]:
                    idx = deduplicated_matches.index(existing_match)
                    deduplicated_matches[idx] = match
                    seen_absolute_paths[absolute_path] = match

        missing_with_matches.append({**missing, "matches": deduplicated_matches})

    return {
        "missing_models": missing_with_matches,
        "total_missing": len(missing_with_matches),
        "total_models_analyzed": len(all_model_refs),
    }


def apply_resolution(
    workflow_json: Dict[str, Any], resolutions: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Apply model resolutions to workflow.

    Args:
        workflow_json: Workflow JSON dictionary (will be modified)
        resolutions: List of resolution dictionaries:
            {
                'node_id': node ID,
                'widget_index': widget index,
                'resolved_path': absolute path to resolved model,
                'category': model category (optional),
                'resolved_model': model dict from scanner (optional),
                'nested_key': nested key for dict-type widgets (optional)
            }

    Returns:
        Updated workflow JSON dictionary
    """
    # Prepare mappings for workflow_updater
    mappings = []
    for resolution in resolutions:
        mapping = {
            "node_id": resolution.get("node_id"),
            "widget_index": resolution.get("widget_index"),
            "resolved_path": resolution.get("resolved_path"),
            "category": resolution.get("category"),
            "resolved_model": resolution.get("resolved_model"),
            "subgraph_id": resolution.get(
                "subgraph_id"
            ),  # Include subgraph_id for subgraph nodes
            "is_top_level": resolution.get(
                "is_top_level"
            ),  # True for top-level nodes, False for nodes in subgraph definitions
            "is_lora_v2": resolution.get("is_lora_v2"),  # Flag for LoraManager nodes
            "original_lora_name": resolution.get(
                "original_lora_name"
            ),  # Original lora name for LoraManager replacement
            "nested_key": resolution.get(
                "nested_key"
            ),  # For dict-type widgets (e.g. Power Lora Loader)
        }

        # If resolved_model provided, extract path if needed
        if "resolved_model" in resolution and resolution["resolved_model"]:
            resolved_model = resolution["resolved_model"]
            if "path" in resolved_model and not mapping.get("resolved_path"):
                mapping["resolved_path"] = resolved_model["path"]
            if "base_directory" in resolved_model:
                mapping["base_directory"] = resolved_model["base_directory"]

        mappings.append(mapping)

    # Update workflow
    updated_workflow = update_workflow_nodes(workflow_json, mappings)

    return updated_workflow


def get_resolution_summary(workflow_json: Dict[str, Any]) -> Dict[str, Any]:
    """
    Get summary of missing models and matches without applying resolutions.

    This is a convenience method that calls analyze_and_find_matches with defaults.

    Args:
        workflow_json: Complete workflow JSON dictionary

    Returns:
        Same format as analyze_and_find_matches
    """
    return analyze_and_find_matches(workflow_json)
