"""
@author: Model Linker Team
@title: ComfyUI Model Linker
@nickname: Model Linker
@version: 1.1.0
@description: Extension for relinking missing models and downloading from HuggingFace/CivitAI
"""

import logging
from .core.log_system.log_funcs import (
    log_debug,
    log_info,
    log_warn,
    log_error,
    log_exception,
)

# Web directory for JavaScript interface
WEB_DIRECTORY = "./web"

# Empty NODE_CLASS_MAPPINGS - we don't provide custom nodes, only web extension
# This prevents ComfyUI from showing "IMPORT FAILED" message
NODE_CLASS_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY"]


class ModelLinkerExtension:
    """Main extension class for Model Linker."""

    def __init__(self):
        self.routes_setup = False
        self.logger = logging.getLogger(__name__)

    def initialize(self):
        """Initialize the extension and set up API routes."""
        try:
            self.setup_routes()
            self.logger.info("Model Linker: Extension initialized successfully")
        except Exception as e:
            self.logger.error(
                f"Model Linker: Extension initialization failed: {e}", exc_info=True
            )

    def setup_routes(self):
        """Register API routes for the Model Linker extension."""
        if self.routes_setup:
            return  # Already set up

        try:
            from aiohttp import web

            # Try to get routes from PromptServer
            try:
                from server import PromptServer

                if (
                    not hasattr(PromptServer, "instance")
                    or PromptServer.instance is None
                ):
                    self.logger.debug("Model Linker: PromptServer not available yet")
                    return False

                routes = PromptServer.instance.routes
            except (ImportError, AttributeError) as e:
                self.logger.debug(f"Model Linker: Could not access PromptServer: {e}")
                return False

            # Import linker modules
            try:
                from .core.linker import (
                    analyze_and_find_matches,
                    apply_resolution,
                    search_local_matches,
                )
                from .core.scanner import get_model_files
            except ImportError as e:
                self.logger.error(f"Model Linker: Could not import core modules: {e}")
                return False

            # Import download modules
            try:
                from .core.downloader import (
                    start_background_download,
                    get_progress,
                    get_all_progress,
                    cancel_download,
                    get_download_directory,
                )
                from .core.sources.popular import (
                    get_popular_model_url,
                    search_popular_models,
                )
                from .core.sources.model_list import (
                    search_model_list,
                    search_model_list_multiple,
                )
                from .core.sources.huggingface import search_huggingface_for_file
                from .core.sources.civitai import (
                    search_civitai_for_file,
                    search_civitai,
                    get_civitai_download_url,
                    resolve_urn,
                )

                download_available = True
            except ImportError as e:
                self.logger.warning(
                    f"Model Linker: Download features not available: {e}"
                )
                download_available = False

            # ==================== ANALYZE ROUTES ====================

            @routes.post("/model_linker/analyze")
            async def analyze_workflow(request):
                """Analyze workflow and return missing models with matches."""
                try:
                    data = await request.json()
                    workflow_json = data.get("workflow")

                    if not workflow_json:
                        return web.json_response(
                            {"error": "Workflow JSON is required"}, status=400
                        )

                    # Analyze and find matches
                    result = analyze_and_find_matches(workflow_json)

                    # Filter out LoraManager lorAs that already exist locally (exists=True)
                    # These should not appear in missing models at all
                    missing_models = result.get("missing_models", [])
                    filtered_missing = []
                    for missing in missing_models:
                        is_lora = missing.get("is_lora_v2")
                        exists = missing.get("exists")
                        name = missing.get("name") or missing.get("original_path", "")
                        # Log for debugging
                        import logging

                        logging.getLogger(__name__).debug(
                            f"Filtering: {name} is_lora_v2={is_lora} exists={exists}"
                        )

                        # Skip LoraManager lorAs that already exist locally
                        if is_lora and exists:
                            logging.getLogger(__name__).info(
                                f"Filtered out LoraManager lora: {name}"
                            )
                            continue
                        filtered_missing.append(missing)
                    result["missing_models"] = filtered_missing
                    result["total_missing"] = len(filtered_missing)

                    # If download available, check for download sources only from LOCAL sources
                    # (workflow_url, popular, model-list.json) - skip automatic online search
                    # Online search is now only triggered on-demand via search button
                    if download_available:
                        for missing in result.get("missing_models", []):
                            # Check if there's a 100% local match
                            matches = missing.get("matches", [])
                            has_perfect_match = any(
                                m.get("confidence", 0) == 100 for m in matches
                            )

                            if not has_perfect_match:
                                filename = (
                                    missing.get("original_path", "")
                                    .split("/")[-1]
                                    .split("\\")[-1]
                                )

                                # 0. Check workflow URL first (highest priority - directly from workflow)
                                workflow_url = missing.get("workflow_url", "")
                                if workflow_url:
                                    # Determine source from URL
                                    if "huggingface.co" in workflow_url:
                                        source = "huggingface"
                                    elif "civitai.com" in workflow_url:
                                        source = "civitai"
                                    else:
                                        source = "workflow"

                                    # Try to get file size with HEAD request (non-blocking, timeout quickly)
                                    file_size = None
                                    try:
                                        import requests

                                        head_response = requests.head(
                                            workflow_url,
                                            allow_redirects=True,
                                            timeout=5,
                                        )
                                        if head_response.status_code == 200:
                                            file_size = int(
                                                head_response.headers.get(
                                                    "content-length", 0
                                                )
                                            )
                                    except Exception:
                                        pass  # Size unknown is fine

                                    missing["download_source"] = {
                                        "source": source,
                                        "url": workflow_url,
                                        "filename": filename,
                                        "directory": missing.get(
                                            "workflow_directory", ""
                                        )
                                        or missing.get("category", "checkpoints"),
                                        "match_type": "exact",
                                        "url_source": "workflow",
                                        "size": file_size,
                                    }
                                    continue

                                # 1. Check popular models (always exact match)
                                popular_info = get_popular_model_url(filename)
                                if popular_info:
                                    missing["download_source"] = {
                                        "source": "popular",
                                        "url": popular_info.get("url"),
                                        "filename": filename,
                                        "type": popular_info.get("type"),
                                        "directory": popular_info.get("directory"),
                                        "match_type": "exact",
                                    }
                                    continue

                                # 2. Check model list (ComfyUI Manager database)
                                # Use exact_only=True to avoid confusing fuzzy matches for downloads
                                model_list_result = search_model_list(
                                    filename, exact_only=True
                                )
                                if model_list_result:
                                    missing["download_source"] = {
                                        "source": "model_list",
                                        "url": model_list_result.get("url"),
                                        "filename": model_list_result.get("filename"),
                                        "name": model_list_result.get("name"),
                                        "type": model_list_result.get("type"),
                                        "directory": model_list_result.get("directory"),
                                        "size": model_list_result.get("size"),
                                        "match_type": model_list_result.get(
                                            "match_type"
                                        ),
                                        "confidence": model_list_result.get(
                                            "confidence"
                                        ),
                                    }
                                    continue

                                # NOTE: Search for online sources (HuggingFace, CivitAI) is
                                # now done on-demand via /model_linker/search endpoint
                                # when user clicks "Search Online" button, not automatically

                    return web.json_response(result)
                except Exception as e:
                    self.logger.error(f"Model Linker analyze error: {e}", exc_info=True)
                    return web.json_response({"error": str(e)}, status=500)

            @routes.post("/model_linker/resolve")
            async def resolve_models(request):
                """Apply model resolution and return updated workflow."""
                try:
                    data = await request.json()
                    workflow_json = data.get("workflow")
                    resolutions = data.get("resolutions", [])

                    if not workflow_json:
                        return web.json_response(
                            {"error": "Workflow JSON is required"}, status=400
                        )

                    if not resolutions:
                        return web.json_response(
                            {"error": "Resolutions array is required"}, status=400
                        )

                    # Apply resolutions
                    updated_workflow = apply_resolution(workflow_json, resolutions)

                    return web.json_response(
                        {"workflow": updated_workflow, "success": True}
                    )
                except Exception as e:
                    self.logger.error(f"Model Linker resolve error: {e}", exc_info=True)
                    return web.json_response(
                        {"error": str(e), "success": False}, status=500
                    )

            @routes.post("/model_linker/local-matches")
            async def local_matches(request):
                """Search local model files by filename/path."""
                try:
                    data = await request.json()
                    filename = data.get("filename", "")
                    category = data.get("category", "")

                    if not filename:
                        return web.json_response(
                            {"error": "filename is required"}, status=400
                        )

                    matches = search_local_matches(
                        filename,
                        category=category or None,
                        similarity_threshold=0.0,
                        max_matches_per_model=10,
                    )
                    return web.json_response({"matches": matches})
                except Exception as e:
                    self.logger.error(
                        f"Model Linker local-matches error: {e}", exc_info=True
                    )
                    return web.json_response({"error": str(e)}, status=500)

            @routes.post("/model_linker/open-containing-folder")
            async def open_containing_folder(request):
                """Open Explorer at the folder containing the selected model."""
                try:
                    import os
                    import subprocess

                    data = await request.json()
                    target_path = data.get("path", "")

                    if not target_path:
                        return web.json_response(
                            {"error": "path is required"}, status=400
                        )

                    normalized_path = os.path.normpath(target_path)
                    if not os.path.exists(normalized_path):
                        return web.json_response(
                            {"error": "path does not exist"}, status=404
                        )

                    if os.path.isfile(normalized_path):
                        absolute_path = os.path.abspath(normalized_path)
                        subprocess.Popen(
                            ["explorer.exe", "/select,", absolute_path],
                            shell=False,
                        )
                    else:
                        os.startfile(normalized_path)

                    return web.json_response({"success": True})
                except Exception as e:
                    self.logger.error(
                        f"Model Linker open-containing-folder error: {e}",
                        exc_info=True,
                    )
                    return web.json_response({"error": str(e)}, status=500)

            @routes.get("/model_linker/models")
            async def get_models(request):
                """Get list of all available models."""
                try:
                    models = get_model_files()
                    return web.json_response(models)
                except Exception as e:
                    self.logger.error(
                        f"Model Linker get_models error: {e}", exc_info=True
                    )
                    return web.json_response({"error": str(e)}, status=500)

            @routes.post("/model_linker/loaded")
            async def get_loaded_models(request):
                """Get all currently loaded models in the workflow."""
                try:
                    data = await request.json()
                    workflow_json = data.get("workflow")

                    if not workflow_json:
                        return web.json_response(
                            {"error": "Workflow JSON is required"}, status=400
                        )

                    # Import workflow analyzer to extract models
                    from .core.workflow_analyzer import (
                        analyze_workflow_models,
                        try_resolve_model_path,
                        is_model_filename,
                        URN_REGEX,
                        URN_TYPE_MAP,
                    )

                    # Get available models for existence checking
                    available_models = get_model_files()
                    available_paths = {m.get("path") for m in available_models}
                    # Create lookup for full paths by filename (with and without extension)
                    path_by_filename = {}
                    for m in available_models:
                        rel_path = m.get("relative_path", "")
                        if rel_path:
                            filename = rel_path.split("/")[-1].split("\\")[-1]
                            path_by_filename[filename] = m.get("path")
                            # Also add without extension for matching (simple approach)
                            if "." in filename:
                                filename_no_ext = filename.rsplit(".", 1)[0]
                                if filename_no_ext not in path_by_filename:
                                    path_by_filename[filename_no_ext] = m.get("path")
                            # Add the full relative path as key too
                            path_by_filename[rel_path] = m.get("path")

                    # Also use folder_paths.get_full_path() to get paths
                    import folder_paths

                    for cat in [
                        "loras",
                        "checkpoints",
                        "vae",
                        "controlnet",
                        "upscale_models",
                    ]:
                        try:
                            filenames = folder_paths.get_filename_list(cat)
                            for fn in filenames:
                                full_path = folder_paths.get_full_path(cat, fn)
                                if (
                                    full_path
                                    and full_path not in path_by_filename.values()
                                ):
                                    path_by_filename[fn] = full_path
                                    fn_no_ext = (
                                        fn.rsplit(".", 1)[0] if "." in fn else fn
                                    )
                                    if fn_no_ext not in path_by_filename:
                                        path_by_filename[fn_no_ext] = full_path
                        except Exception:
                            pass

                    # Analyze workflow to get all model references
                    all_model_refs = analyze_workflow_models(workflow_json)

                    # Also extract from node.properties.models
                    nodes = list(workflow_json.get("nodes", []))
                    definitions = workflow_json.get("definitions", {})
                    subgraphs = definitions.get("subgraphs", [])
                    for subgraph in subgraphs:
                        nodes.extend(subgraph.get("nodes", []))

                    # Collect all loaded models with their values
                    loaded_models = []

                    # Process each model reference from analyze_workflow_models
                    for ref in all_model_refs:
                        original_path = ref.get("original_path", "")
                        node_id = ref.get("node_id")
                        widget_index = ref.get("widget_index")
                        node_type = ref.get("node_type", "")
                        category = ref.get("category", "unknown")

                        # Determine model name and strength
                        model_name = original_path.split("/")[-1].split("\\")[-1]
                        strength = None

                        # For standard LoraLoader nodes, strength is in next widget_value
                        if node_type in ["LoraLoader", "LoraLoaderModelOnly"]:
                            # Find the node in workflow to get strength value
                            for node in nodes:
                                if str(node.get("id")) == str(node_id):
                                    widgets_values = node.get("widgets_values", [])
                                    if len(widgets_values) > widget_index + 1:
                                        try:
                                            strength = float(
                                                widgets_values[widget_index + 1]
                                            )
                                        except (ValueError, TypeError):
                                            strength = 1.0
                                    break

                        # For text-based lora loaders (LoraLoaderV2, LoraManager), get strength from ref
                        if ref.get("is_lora_v2"):
                            strength = ref.get("strength")
                            model_name = ref.get("name", model_name)

                        # Check if model exists locally
                        exists = ref.get("exists", False)

                        # If URN, resolve to display name
                        if ref.get("is_urn"):
                            urn = ref.get("urn", {})
                            # Use model name from URN as display name
                            model_name = (
                                f"urn:{urn.get('type', 'model')}:{urn.get('model_id')}"
                            )
                            category = urn.get("type", category)
                            if category in URN_TYPE_MAP:
                                category = URN_TYPE_MAP[category]

                        loaded_models.append(
                            {
                                "name": model_name,
                                "category": category,
                                "node_id": node_id,
                                "widget_index": widget_index,
                                "node_type": node_type,
                                "exists": exists,
                                "strength": strength,
                                "original_path": original_path,
                                "is_urn": ref.get("is_urn", False),
                                "is_lora_v2": ref.get("is_lora_v2", False),
                                "active": ref.get("active"),
                                "connected": ref.get("connected", True),
                                "resolved_path": (
                                    path_by_filename.get(model_name)
                                    or path_by_filename.get(original_path)
                                ),
                            }
                        )

                    # Also check node.properties.models for embedded models
                    for node in nodes:
                        node_type = node.get("type", "")
                        properties = node.get("properties", {})
                        models_list = properties.get("models", [])

                        for model_info in models_list:
                            if isinstance(model_info, dict):
                                name = model_info.get("name", "")
                                url = model_info.get("url", "")
                                directory = model_info.get("directory", "")

                                if name:
                                    # Check if this model is already in loaded_models
                                    existing = next(
                                        (
                                            m
                                            for m in loaded_models
                                            if m.get("original_path") == name
                                        ),
                                        None,
                                    )
                                    if not existing:
                                        loaded_models.append(
                                            {
                                                "name": name.split("/")[-1].split("\\")[
                                                    -1
                                                ],
                                                "category": directory or "checkpoints",
                                                "node_id": node.get("id"),
                                                "widget_index": None,
                                                "node_type": node_type,
                                                "exists": True,  # Embedded models are loaded
                                                "strength": None,
                                                "original_path": name,
                                                "is_urn": False,
                                            }
                                        )

                    return web.json_response(
                        {"loaded_models": loaded_models, "total": len(loaded_models)}
                    )

                except Exception as e:
                    self.logger.error(
                        f"Model Linker get_loaded_models error: {e}", exc_info=True
                    )
                    return web.json_response({"error": str(e)}, status=500)

            # ==================== CIVITAI SEARCH ROUTE ====================

            @routes.post("/model_linker/civitai-search")
            async def civitai_search(request):
                """Search CivitAI for a model using file hash."""
                try:
                    data = await request.json()
                    filename = data.get("filename", "")
                    category = data.get("category", "")
                    resolved_path = data.get("resolved_path", "")

                    if not filename:
                        return web.json_response(
                            {"error": "Filename is required"}, status=400
                        )

                    # Clean filename for display
                    import os as _os

                    clean_name = _os.path.splitext(filename)[0]

                    # Get the file path to hash
                    file_path = resolved_path if resolved_path else None

                    if not file_path and category:
                        # Try to find the file in the model directories using folder_paths
                        try:
                            import folder_paths

                            # Map category to folder_paths type
                            category_map = {
                                "loras": "loras",
                                "checkpoints": "checkpoints",
                                "vae": "vae",
                                "controlnet": "controlnet",
                                "upscale_models": "upscale_models",
                            }
                            folder_type = category_map.get(
                                category.lower(), category.lower()
                            )
                            file_path = folder_paths.get_full_path(
                                folder_type, filename
                            )
                        except Exception:
                            pass

                        # If not found, try scanner
                        if not file_path:
                            try:
                                from .core.scanner import get_model_files

                                available_models = get_model_files()
                                for m in available_models:
                                    if (
                                        m.get("relative_path", "").endswith(filename)
                                        or m.get("filename", "") == filename
                                    ):
                                        file_path = m.get("path")
                                        break
                            except Exception:
                                pass

                    # Search CivitAI for the model using hash
                    if download_available and file_path and _os.path.exists(file_path):
                        try:
                            from .core.sources.civitai import (
                                get_model_info_for_file,
                            )

                            result = get_model_info_for_file(file_path)
                            if result and result.get("url"):
                                return web.json_response(
                                    {
                                        "filename": filename,
                                        "url": result.get("url"),
                                        "version_url": result.get("version_url"),
                                        "model_id": result.get("model_id"),
                                        "model_name": result.get(
                                            "model_name", clean_name
                                        ),
                                        "model_type": result.get("model_type", ""),
                                        "version_id": result.get("version_id"),
                                        "version_name": result.get("version_name", ""),
                                        "sha256": result.get("sha256"),
                                        "base_model": result.get("base_model"),
                                        "tags": result.get("tags", []),
                                        "trained_words": result.get(
                                            "trained_words", []
                                        ),
                                        "images": result.get("images", []),
                                        "clip_skip": result.get("clip_skip"),
                                        "description": result.get("description", ""),
                                        "model_description": result.get(
                                            "model_description", ""
                                        ),
                                    }
                                )
                        except Exception as e:
                            self.logger.warning(f"CivitAI search error: {e}")

                    # No result found - try fallback to filename search
                    if download_available:
                        try:
                            from .core.sources.civitai import (
                                search_civitai_for_file,
                            )

                            result = search_civitai_for_file(filename)
                            if result and result.get("url"):
                                return web.json_response(
                                    {
                                        "url": result["url"],
                                        "model_name": result.get("name", clean_name),
                                        "version_id": result.get("version_id"),
                                    }
                                )
                        except Exception as e:
                            self.logger.warning(f"CivitAI fallback search error: {e}")

                    # No result found
                    return web.json_response({"url": None})

                except Exception as e:
                    self.logger.error(
                        f"Model Linker civitai-search error: {e}", exc_info=True
                    )
                    return web.json_response({"error": str(e)}, status=500)

            # ==================== DOWNLOAD ROUTES ====================

            if download_available:

                @routes.post("/model_linker/search")
                async def search_sources(request):
                    """Search for model download sources."""
                    try:
                        data = await request.json()
                        filename = data.get("filename", "")
                        category = data.get("category", "")
                        # Handle both boolean and string forms
                        is_urn_raw = data.get("is_urn", False)
                        is_urn = (
                            is_urn_raw
                            if isinstance(is_urn_raw, bool)
                            else (str(is_urn_raw).lower() == "true")
                        )

                        # For URN-only requests, model_id and version_id are required instead of filename
                        model_id = data.get("model_id")
                        version_id = data.get("version_id")
                        if not filename and not (is_urn and model_id and version_id):
                            return web.json_response(
                                {
                                    "error": "Filename is required for non-URN, or model_id+version_id for URN"
                                },
                                status=400,
                            )

                        raw_sources = data.get("sources", ["all"])
                        if isinstance(raw_sources, str):
                            raw_sources = [raw_sources]
                        elif not isinstance(raw_sources, list):
                            raw_sources = ["all"]

                        normalized_sources = {
                            str(source).strip().lower()
                            for source in raw_sources
                            if str(source).strip()
                        }
                        if not normalized_sources:
                            normalized_sources = {"all"}

                        if "all" in normalized_sources:
                            normalized_sources = {"local", "huggingface", "civitai"}

                        search_local = "local" in normalized_sources
                        search_huggingface_source = "huggingface" in normalized_sources
                        search_civitai_source = "civitai" in normalized_sources

                        # Debug logging
                        self.logger.info(
                            f"Search request: filename={filename}, category={category}, is_urn={is_urn}, model_id={data.get('model_id')}, version_id={data.get('version_id')}, sources={sorted(normalized_sources)}"
                        )

                        results = {
                            "popular": None,
                            "model_list": None,
                            "huggingface": None,
                            "civitai": None,
                            "found": False,
                            "searched_sources": sorted(normalized_sources),
                        }

                        # 1. Search local databases (curated + model-list)
                        if search_local:
                            popular_info = get_popular_model_url(filename)
                            if popular_info:
                                results["popular"] = {
                                    "source": "popular",
                                    "filename": filename,
                                    **popular_info,
                                }
                                results["found"] = True

                            model_list_result = search_model_list(filename)
                            if model_list_result:
                                confidence = model_list_result.get("confidence", 0)
                                if is_urn and confidence >= 70:
                                    results["model_list"] = model_list_result
                                    results["found"] = True
                                elif not is_urn:
                                    results["model_list"] = model_list_result
                                    results["found"] = True

                        # 2. Search HuggingFace for exact file match
                        if search_huggingface_source:
                            hf_result = search_huggingface_for_file(filename)
                            if hf_result:
                                results["huggingface"] = hf_result
                                results["found"] = True

                        # 3. Search CivitAI - use direct download for URNs
                        if search_civitai_source:
                            # For URNs, use direct model_id/version_id to get download URL
                            if is_urn:
                                # Get model_id and version_id from request data
                                model_id = data.get("model_id")
                                version_id = data.get("version_id")

                                if model_id and version_id:
                                    # Use resolve_urn to get model info (cached)
                                    model_info = resolve_urn(model_id, version_id)
                                    if model_info:
                                        primary_file = None
                                        for file_info in model_info.get("files", []):
                                            if (
                                                file_info.get("name")
                                                == model_info.get("expected_filename")
                                            ):
                                                primary_file = file_info
                                                break
                                        if primary_file is None:
                                            primary_file = (
                                                model_info.get("files") or [{}]
                                            )[0]

                                        download_url = get_civitai_download_url(
                                            version_id
                                        )
                                        results["civitai"] = {
                                            "source": "civitai",
                                            "name": model_info.get("model_name"),
                                            "version_name": model_info.get(
                                                "version_name"
                                            ),
                                            "filename": model_info.get(
                                                "expected_filename"
                                            ),
                                            "type": category,
                                            "download_url": download_url,
                                            "url": f"https://civitai.com/models/{model_id}?modelVersionId={version_id}",
                                            "model_id": model_id,
                                            "version_id": version_id,
                                            "size": primary_file.get("size"),
                                        }
                                        results["found"] = True
                                elif category:
                                    # Fallback to search if no IDs
                                    self.logger.info(
                                        f"URN: No model_id/version_id, falling back to CivitAI search"
                                    )
                                    civitai_results = search_civitai(
                                        filename, model_type=category
                                    )
                                    if civitai_results:
                                        first_result = civitai_results[0]
                                        results["civitai"] = {
                                            "source": "civitai",
                                            "name": first_result.get("name"),
                                            "filename": first_result.get("filename"),
                                            "type": first_result.get("type"),
                                            "download_url": first_result.get(
                                                "download_url"
                                            ),
                                            "url": first_result.get("url"),
                                            "size": first_result.get("size"),
                                        }
                                        results["found"] = True
                            else:
                                civitai_result = search_civitai_for_file(filename)
                                if civitai_result:
                                    results["civitai"] = civitai_result
                                    results["found"] = True

                        return web.json_response(results)

                    except Exception as e:
                        self.logger.error(
                            f"Model Linker search error: {e}", exc_info=True
                        )
                        return web.json_response({"error": str(e)}, status=500)

                @routes.post("/model_linker/download")
                async def download_model(request):
                    """Start downloading a model."""
                    try:
                        data = await request.json()
                        url = data.get("url", "")
                        filename = data.get("filename", "")
                        category = data.get("category", "checkpoints")
                        subfolder = data.get("subfolder", "")

                        if not url:
                            return web.json_response(
                                {"error": "URL is required"}, status=400
                            )

                        if not filename:
                            # Extract filename from URL
                            from urllib.parse import urlparse, unquote

                            parsed = urlparse(url)
                            filename = unquote(parsed.path.split("/")[-1])

                        if not filename:
                            return web.json_response(
                                {"error": "Could not determine filename"}, status=400
                            )

                        # Build headers if needed
                        headers = {}
                        if "huggingface.co" in url:
                            hf_token = data.get("hf_token", "")
                            if hf_token:
                                headers["Authorization"] = f"Bearer {hf_token}"
                        elif "civitai.com" in url:
                            civitai_key = data.get("civitai_key", "")
                            if civitai_key and "token=" not in url:
                                url += (
                                    f"{'&' if '?' in url else '?'}token={civitai_key}"
                                )

                        # Start background download
                        download_id = start_background_download(
                            url=url,
                            filename=filename,
                            category=category,
                            headers=headers if headers else None,
                            subfolder=subfolder,
                        )

                        return web.json_response(
                            {
                                "success": True,
                                "download_id": download_id,
                                "filename": filename,
                                "category": category,
                            }
                        )

                    except Exception as e:
                        self.logger.error(
                            f"Model Linker download error: {e}", exc_info=True
                        )
                        return web.json_response(
                            {"error": str(e), "success": False}, status=500
                        )

                @routes.get("/model_linker/progress/{download_id}")
                async def get_download_progress(request):
                    """Get progress for a specific download."""
                    try:
                        download_id = request.match_info["download_id"]
                        progress = get_progress(download_id)

                        if progress:
                            return web.json_response(progress)
                        else:
                            return web.json_response(
                                {"error": "Download not found"}, status=404
                            )
                    except Exception as e:
                        self.logger.error(
                            f"Model Linker progress error: {e}", exc_info=True
                        )
                        return web.json_response({"error": str(e)}, status=500)

                @routes.get("/model_linker/progress")
                async def get_all_downloads_progress(request):
                    """Get progress for all downloads."""
                    try:
                        progress = get_all_progress()
                        return web.json_response(progress)
                    except Exception as e:
                        self.logger.error(
                            f"Model Linker progress error: {e}", exc_info=True
                        )
                        return web.json_response({"error": str(e)}, status=500)

                @routes.post("/model_linker/cancel/{download_id}")
                async def cancel_download_route(request):
                    """Cancel a download in progress."""
                    try:
                        download_id = request.match_info["download_id"]
                        cancel_download(download_id)
                        return web.json_response({"success": True})
                    except Exception as e:
                        self.logger.error(
                            f"Model Linker cancel error: {e}", exc_info=True
                        )
                        return web.json_response(
                            {"error": str(e), "success": False}, status=500
                        )

                @routes.get("/model_linker/directories")
                async def get_directories(request):
                    """Get available model directories."""
                    try:
                        categories = [
                            "checkpoints",
                            "loras",
                            "vae",
                            "controlnet",
                            "clip",
                            "clip_vision",
                            "embeddings",
                            "upscale_models",
                            "diffusion_models",
                            "text_encoders",
                            "ipadapter",
                            "sams",
                        ]

                        directories = {}
                        for cat in categories:
                            path = get_download_directory(cat)
                            if path:
                                directories[cat] = path

                        return web.json_response(directories)
                    except Exception as e:
                        self.logger.error(
                            f"Model Linker directories error: {e}", exc_info=True
                        )
                        return web.json_response({"error": str(e)}, status=500)

            self.routes_setup = True
            self.logger.info("Model Linker: API routes registered successfully")
            return True

        except ImportError as e:
            self.logger.warning(
                f"Model Linker: Could not register routes (missing dependency): {e}"
            )
            return False
        except Exception as e:
            self.logger.error(
                f"Model Linker: Error setting up routes: {e}", exc_info=True
            )
            return False


# Initialize the extension
try:
    extension = ModelLinkerExtension()
    extension.initialize()
except Exception as e:
    log_error(
        f"ComfyUI Model Linker extension initialization failed: {e}", exc_info=True
    )
