"""
Workflow Analyzer Module

Extracts model references from workflow JSON and identifies missing models.
"""

import os
import logging
from typing import List, Dict, Any, Optional

from .log_system.log_funcs import log_debug, log_info, log_warn, log_error, log_exception

# Import folder_paths lazily - it may not be available until ComfyUI is initialized
try:
    import folder_paths
except ImportError:
    folder_paths = None
    logging.warning("Model Linker: folder_paths not available yet - will retry later")


# Common model file extensions
MODEL_EXTENSIONS = {
    ".ckpt",
    ".pt",
    ".pt2",
    ".bin",
    ".pth",
    ".safetensors",
    ".pkl",
    ".sft",
    ".onnx",
    ".gguf",
}

import re

# URN Type to ComfyUI category mapping
URN_TYPE_MAP = {
    "checkpoint": "checkpoints",
    "lora": "loras",
    "vae": "vae",
    "upscaler": "upscale_models",
    "upscale_model": "upscale_models",
    "embedding": "embeddings",
    "hypernetwork": "hypernetworks",
    "controlnet": "controlnet",
    "clip": "clip",
    "clip_vision": "clip_vision",
}

URN_REGEX = re.compile(r"^urn:air:([^:]+):([^:]+):([^:]+):(\d+)@(\d+)$")

# Mapping of common node types to their expected model category
# This is used as hints but we don't rely solely on this
# UNETLoader uses 'diffusion_models' category (folder_paths maps 'unet' to 'diffusion_models')
NODE_TYPE_TO_CATEGORY_HINTS = {
    "CheckpointLoaderSimple": "checkpoints",
    "CheckpointLoader": "checkpoints",
    "unCLIPCheckpointLoader": "checkpoints",
    "VAELoader": "vae",
    "LoraLoader": "loras",
    "LoraLoaderModelOnly": "loras",
    "LoraLoaderV2": "loras",
    "Lora Loader (LoraManager)": "loras",  # LoraManager custom node
    "Lora Stacker (LoraManager)": "loras",  # LoraManager Stacker node
    "Power Lora Loader (rgthree)": "loras",  # rgthree's Power Lora Loader
    "UNETLoader": "diffusion_models",
    "ControlNetLoader": "controlnet",
    "ControlNetLoaderAdvanced": "controlnet",
    "CLIPVisionLoader": "clip_vision",
    "UpscaleModelLoader": "upscale_models",
    "HypernetworkLoader": "hypernetworks",
    "EmbeddingLoader": "embeddings",
    # LTX-Video nodes
    "LTXVAudioVAELoader": "checkpoints",
    "LowVRAMAudioVAELoader": "checkpoints",
    "LTXVGemmaCLIPModelLoader": "text_encoders",
}

# Keys within dict-type widget values that contain model file references.
# Some nodes (e.g. rgthree Power Lora Loader) store model info as objects like
# {"on": true, "lora": "name.safetensors", "strength": 1.0} inside widgets_values.
# Maps nested key name -> category hint.
NESTED_MODEL_KEYS = {
    "lora": "loras",
    "ckpt_name": "checkpoints",
    "checkpoint": "checkpoints",
    "vae_name": "vae",
    "control_net_name": "controlnet",
}


def is_model_filename(value: Any) -> bool:
    """
    Check if a value looks like a model filename or URN.

    Args:
        value: The value to check

    Returns:
        True if it looks like a model filename or URN
    """
    if not isinstance(value, str):
        return False

    # Check model extension
    _, ext = os.path.splitext(value.lower())
    if ext in MODEL_EXTENSIONS:
        return True

    # Check URN format
    return bool(URN_REGEX.match(value.strip()))


def try_resolve_model_path(
    value: str, categories: List[str] = None
) -> Optional[tuple[str, str]]:
    """
    Try to resolve a model path using folder_paths.

    Args:
        value: The model filename/path to resolve
        categories: Optional list of categories to try (if None, tries all)

    Returns:
        Tuple of (category, full_path) if found, None otherwise
    """
    if not isinstance(value, str) or not value.strip():
        return None

    # Remove any path separators that might indicate an absolute path prefix
    # Workflows should store relative paths, but handle both cases
    filename = value.strip()

    # Ensure folder_paths is available
    global folder_paths
    if folder_paths is None:
        try:
            import folder_paths as fp

            folder_paths = fp
        except ImportError:
            logging.error("Model Linker: folder_paths not available")
            return None

    # If categories not provided, try all categories
    if categories is None:
        categories = list(folder_paths.folder_names_and_paths.keys())

    # Skip non-model categories
    skip_categories = {"custom_nodes", "configs"}
    categories = [c for c in categories if c not in skip_categories]

    for category in categories:
        try:
            full_path = folder_paths.get_full_path(category, filename)
            if full_path and os.path.exists(full_path):
                return (category, full_path)
        except Exception:
            continue

    return None


def get_node_model_info(node: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Extract model references from a single node.

    This scans all widgets_values entries and tries to identify which ones
    are model file references by attempting to resolve them.

    Args:
        node: Node dictionary from workflow JSON

    Returns:
        List of model reference dictionaries:
        {
            'node_id': node id,
            'node_type': node type,
            'widget_index': index in widgets_values,
            'original_path': original path from workflow,
            'category': model category (if found),
            'exists': True if model exists,
            'connected': True if node has any connected inputs/outputs
        }
    """
    model_refs = []
    node_id = node.get("id")
    node_type = node.get("type", "")
    widgets_values = node.get("widgets_values", [])

    # Check if node is connected (has any inputs or outputs with links)
    inputs = node.get("inputs", [])
    outputs = node.get("outputs", [])
    is_connected = any(inp.get("link") is not None for inp in inputs) or any(
        out.get("links") and len(out.get("links", [])) > 0 for out in outputs
    )

    # Check if node is in bypass mode (mode 4)
    node_mode = node.get("mode", 0)
    is_bypassed = node_mode == 4

    # Node is active if connected AND not bypassed
    is_active = is_connected and not is_bypassed

    if not widgets_values:
        return model_refs

    # Special handling for text-based lora loaders (LoraLoaderV2, LoraManager, etc.)
    lora_text_types = [
        "LoraLoaderV2",
        "Lora Loader (LoraManager)",
        "Lora Stacker (LoraManager)",
    ]
    is_lora_text = node_type in lora_text_types
    if is_lora_text and len(widgets_values) >= 3:
        # widgets_values[0] = {"version": 1, "textWidgetName": "text"}
        # widgets_values[1] = "<lora:name1:strength> <lora:name2:strength>"
        # widgets_values[2] = [{"name": "...", "strength": 1, "active": true}, ...]

        # Get all lora files using scanner for recursive search
        from .scanner import get_model_files

        all_loras = get_model_files()
        lora_files = [m for m in all_loras if m.get("category") == "loras"]

        # Build a lookup by filename (without extension)
        lora_lookup = {}
        for lf in lora_files:
            fname = lf.get("filename", "")
            if fname:
                # Get name without extension for matching
                base_name = os.path.splitext(fname)[0]
                if base_name not in lora_lookup:
                    lora_lookup[base_name] = []
                lora_lookup[base_name].append(lf)

        lora_list = widgets_values[2]
        if isinstance(lora_list, list):
            for lora_item in lora_list:
                if isinstance(lora_item, dict):
                    name = lora_item.get("name", "")
                    strength = lora_item.get("strength", 1.0)
                    active = lora_item.get("active", True)

                    if name:
                        # Check if lora exists locally using scanner data (recursive search)
                        lora_exists = False
                        lora_full_path = None

                        # Try exact name first (without extension)
                        if name in lora_lookup:
                            lora_full_path = lora_lookup[name][0].get("path")
                            lora_exists = (
                                os.path.exists(lora_full_path)
                                if lora_full_path
                                else False
                            )
                        else:
                            # Try with common extensions
                            for ext in [".safetensors", ".ckpt", ".pt", ".pth"]:
                                test_name = name + ext
                                if test_name in lora_lookup:
                                    lora_full_path = lora_lookup[test_name][0].get(
                                        "path"
                                    )
                                    lora_exists = (
                                        os.path.exists(lora_full_path)
                                        if lora_full_path
                                        else False
                                    )
                                    if lora_exists:
                                        break

                        logging.debug(
                            f"Lora {name}: exists={lora_exists}, path={lora_full_path}"
                        )

                        model_refs.append(
                            {
                                "node_id": node_id,
                                "node_type": node_type,
                                "widget_index": 2,  # Index in lora list
                                "original_path": name,
                                "name": name,
                                "strength": float(strength),
                                "active": active,
                                "category": "loras",
                                "full_path": lora_full_path,
                                "exists": lora_exists,
                                "is_urn": False,
                                "is_lora_v2": is_lora_text,
                                "connected": is_active,
                            }
                        )
        return model_refs

    # Get category hints for this node type
    category_hint = NODE_TYPE_TO_CATEGORY_HINTS.get(node_type)
    categories_to_try = [category_hint] if category_hint else None

    # For each widget value, check if it looks like a model file or URN
    for idx, value in enumerate(widgets_values):
        if not is_model_filename(value):
            # Check for dict-type widget values containing model references (e.g. Power Lora Loader)
            # Some nodes store model info as objects like {"on": true, "lora": "name.safetensors", "strength": 1.0}
            if isinstance(value, dict):
                for nested_key, nested_category_hint in NESTED_MODEL_KEYS.items():
                    nested_value = value.get(nested_key)
                    if (
                        not nested_value
                        or not isinstance(nested_value, str)
                        or not is_model_filename(nested_value)
                    ):
                        continue

                    value_str = nested_value.strip()
                    nested_categories = (
                        [nested_category_hint] if nested_category_hint else None
                    )

                    resolved = try_resolve_model_path(value_str, nested_categories)
                    if resolved:
                        category, full_path = resolved
                        exists = os.path.exists(full_path)
                    else:
                        category = nested_category_hint or "unknown"
                        full_path = None
                        exists = False

                    model_refs.append(
                        {
                            "node_id": node_id,
                            "node_type": node_type,
                            "widget_index": idx,
                            "original_path": value_str,
                            "category": category,
                            "full_path": full_path,
                            "exists": exists,
                            "is_urn": False,
                            "connected": is_active,
                            "nested_key": nested_key,  # Track nested key for updates
                        }
                    )
            continue

        value_str = str(value).strip()

        # Check if URN
        urn_match = URN_REGEX.match(value_str)
        if urn_match:
            base, typ, provider, model_id, version_id = urn_match.groups()
            category = URN_TYPE_MAP.get(typ.lower(), "unknown")

            model_refs.append(
                {
                    "node_id": node_id,
                    "node_type": node_type,
                    "widget_index": idx,
                    "original_path": value_str,
                    "urn": {
                        "full": value_str,
                        "base": base,
                        "type": typ,
                        "provider": provider,
                        "model_id": int(model_id),
                        "version_id": int(version_id),
                    },
                    "category": category,
                    "full_path": None,
                    "exists": False,
                    "is_urn": True,
                    "connected": is_active,
                }
            )
            continue

        # Existing logic for local filenames
        resolved = try_resolve_model_path(value_str, categories_to_try)

        if resolved:
            category, full_path = resolved
            exists = os.path.exists(full_path)
        else:
            category = category_hint or "unknown"
            full_path = None
            exists = False

        model_refs.append(
            {
                "node_id": node_id,
                "node_type": node_type,
                "widget_index": idx,
                "original_path": value_str,
                "category": category,
                "full_path": full_path,
                "exists": exists,
                "is_urn": False,
                "connected": is_active,
            }
        )

    return model_refs


def analyze_workflow_models(workflow_json: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Extract all model references from a workflow, including nested subgraphs.

    Args:
        workflow_json: Complete workflow JSON dictionary

    Returns:
        List of model reference dictionaries (same format as get_node_model_info)
        Each dict includes 'subgraph_id' if the model is in a subgraph
    """
    all_model_refs = []

    # Get subgraph definitions first to check if node types are subgraph UUIDs
    definitions = workflow_json.get("definitions", {})
    subgraphs = definitions.get("subgraphs", [])
    subgraph_lookup = {sg.get("id"): sg.get("name", sg.get("id")) for sg in subgraphs}

    # Analyze top-level nodes
    nodes = workflow_json.get("nodes", [])
    for node in nodes:
        try:
            model_refs = get_node_model_info(node)
            node_type = node.get("type", "")

            # Check if node type is a subgraph UUID
            subgraph_name = None
            subgraph_id = None
            if node_type in subgraph_lookup:
                subgraph_name = subgraph_lookup[node_type]
                subgraph_id = node_type

            # Mark with subgraph info if it's a subgraph node
            # For top-level subgraph instance nodes, subgraph_path is None
            # This distinguishes them from nodes within subgraph definitions
            for ref in model_refs:
                ref["subgraph_id"] = subgraph_id
                ref["subgraph_name"] = subgraph_name
                ref["subgraph_path"] = None  # Top-level, not in definitions.subgraphs
                ref["is_top_level"] = True  # Flag to indicate this is a top-level node
            all_model_refs.extend(model_refs)
        except Exception as e:
            logging.warning(f"Error analyzing node {node.get('id', 'unknown')}: {e}")
            continue

    # Recursively analyze subgraphs (definitions already loaded above)
    if not subgraphs:  # Re-get if not loaded above
        subgraphs = definitions.get("subgraphs", [])

    for subgraph in subgraphs:
        subgraph_id = subgraph.get("id")
        subgraph_name = subgraph.get("name", subgraph_id)
        subgraph_nodes = subgraph.get("nodes", [])

        logging.debug(
            f"Analyzing subgraph: {subgraph_name} (ID: {subgraph_id}) with {len(subgraph_nodes)} nodes"
        )

        for node in subgraph_nodes:
            try:
                model_refs = get_node_model_info(node)
                # Mark as belonging to this subgraph definition
                for ref in model_refs:
                    ref["subgraph_id"] = subgraph_id
                    ref["subgraph_name"] = subgraph_name
                    ref["subgraph_path"] = [
                        "definitions",
                        "subgraphs",
                        subgraph_id,
                        "nodes",
                    ]
                    ref["is_top_level"] = False  # This is inside a subgraph definition
                all_model_refs.extend(model_refs)
            except Exception as e:
                logging.warning(
                    f"Error analyzing subgraph node {node.get('id', 'unknown')}: {e}"
                )
                continue

    return all_model_refs


def identify_missing_models(
    workflow_models: List[Dict[str, Any]], available_models: List[Dict[str, str]] = None
) -> List[Dict[str, Any]]:
    """
    Identify which models from the workflow are missing.
    Deduplicates by filename - same model file only appears once even if
    referenced by multiple nodes.

    Args:
        workflow_models: List of model references from analyze_workflow_models
        available_models: Optional list of available models (if None, checks via folder_paths)

    Returns:
        List of missing model references (deduplicated by filename).
        Each entry has 'all_node_refs' containing all node references for that model.
    """
    # Group missing models by filename to deduplicate
    missing_by_filename: Dict[str, Dict[str, Any]] = {}

    for model_ref in workflow_models:
        # If exists is False, it's missing
        if not model_ref.get("exists", False):
            filename = model_ref.get("original_path", "")

            if filename not in missing_by_filename:
                # First occurrence - use this as the primary entry
                missing_by_filename[filename] = {
                    **model_ref,
                    "all_node_refs": [
                        model_ref.copy()
                    ],  # Track all nodes needing this model
                }
            else:
                # Duplicate - just add to the node refs list
                missing_by_filename[filename]["all_node_refs"].append(model_ref.copy())

    # Return deduplicated list
    return list(missing_by_filename.values())
