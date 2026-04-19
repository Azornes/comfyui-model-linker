"""
Workflow Updater Module

Updates workflow JSON by replacing model paths in nodes.
"""

import os
import logging
from typing import Dict, Any, List, Optional


def convert_to_relative_path(
    absolute_path: str, category: str, base_directory: str = None
) -> str:
    """
    Convert an absolute path to a relative path for workflow storage.

    This should match the format that ComfyUI's get_filename_list() returns,
    which uses relative paths from the category base directory with forward slashes.

    Args:
        absolute_path: Full absolute path to the model file
        category: Model category (e.g., 'checkpoints', 'loras')
        base_directory: Optional base directory for the category

    Returns:
        Relative path (filename or subfolder/filename) suitable for workflow storage
        This MUST match the format ComfyUI uses for validation
    """
    if not absolute_path or not os.path.isabs(absolute_path):
        # Already relative or empty - return as-is (keep OS-native separators)
        # Don't normalize path separators - must match ComfyUI's format exactly
        return absolute_path

    # Use folder_paths.get_filename_list to find the exact format ComfyUI expects
    # CRITICAL: ComfyUI uses OS-native path separators (backslashes on Windows, forward slashes on Unix)
    # We must return the EXACT format from get_filename_list, not a normalized version
    try:
        import folder_paths

        # Get all available filenames for this category
        # This returns paths with OS-native separators (backslashes on Windows)
        available_filenames = folder_paths.get_filename_list(category)

        # Try to find a matching entry in ComfyUI's list
        # Compare by finding the file that resolves to our absolute path
        for filename in available_filenames:
            try:
                full_path = folder_paths.get_full_path(category, filename)
                if full_path and os.path.normpath(full_path) == os.path.normpath(
                    absolute_path
                ):
                    # Found exact match - return ComfyUI's format EXACTLY as-is
                    # This includes OS-native path separators
                    return filename
            except Exception:
                continue
    except Exception:
        # Fall back to manual calculation if folder_paths not available
        pass

    # If base_directory is provided, calculate relative to it
    # IMPORTANT: Use OS-native path separators (don't normalize to forward slashes)
    # ComfyUI expects paths with backslashes on Windows, forward slashes on Unix
    if base_directory:
        try:
            relative_path = os.path.relpath(absolute_path, base_directory)
            # DO NOT normalize path separators - use OS-native format
            # This matches what ComfyUI's recursive_search returns
            return relative_path
        except ValueError:
            # Paths are on different drives (Windows) or can't be relativized
            # Fall back to just filename
            pass

    # Fallback: return just the filename
    return os.path.basename(absolute_path)


def get_base_directory_for_model(
    model_dict: Dict[str, str], category: str
) -> Optional[str]:
    """
    Get the base directory for a model based on its metadata.

    Args:
        model_dict: Model dictionary with 'base_directory' or 'path' key
        category: Model category

    Returns:
        Base directory path if found, None otherwise
    """
    # Try to get base_directory from model dict
    if "base_directory" in model_dict:
        return model_dict["base_directory"]

    # If we have the full path, try to find the category base directory
    if "path" in model_dict:
        full_path = model_dict["path"]
        # Import here to avoid circular dependency
        import folder_paths

        # Try to get category directories
        if category in folder_paths.folder_names_and_paths:
            category_paths = folder_paths.get_folder_paths(category)
            # Find which base directory this path belongs to
            for base_dir in category_paths:
                try:
                    if os.path.commonpath([full_path, base_dir]) == base_dir:
                        return base_dir
                except (ValueError, FileNotFoundError):
                    continue

    return None


def update_model_path(
    workflow: Dict[str, Any],
    node_id: int,
    widget_index: int,
    resolved_path: str,
    category: str = None,
    base_directory: str = None,
    resolved_model: Dict[str, Any] = None,
    subgraph_id: str = None,
    is_top_level: bool = None,
    mapping: Dict[str, Any] = None,
) -> bool:
    """
        Update a single model path in a workflow node, supporting both top-level and subgraph nodes.

        Args:
            workflow: Workflow JSON dictionary
            node_id: ID of the node to update
            widget_index: Widget index to update
            resolved_path: Absolute path to resolved model
            category: Model category
            base_directory: Base directory for category
            resolved_model: Model dict from scanner
            subgraph_id: Subgraph ID (if node is in subgraph)
            is_top_level: Whether node is in top-level (not subgraph definition)
            mapping: Full mapping dict with is_lora_v2 and original_lora_name for LoraManager

    Returns:
            True if update was successful, False otherwise
    """
    node = None

    # Determine if this is a top-level node or inside a subgraph definition
    # - If is_top_level is True, it's a top-level node (even if it's a subgraph instance)
    # - If is_top_level is False, it's inside a subgraph definition
    # - If is_top_level is None and subgraph_id is set, check if node exists in top-level first
    search_in_subgraph = False

    if is_top_level is False:
        # Explicitly inside a subgraph definition
        search_in_subgraph = True
    elif is_top_level is True:
        # Explicitly a top-level node
        search_in_subgraph = False
    elif subgraph_id:
        # Auto-detect: Check if node exists in top-level nodes first
        # (Top-level subgraph instances have subgraph_id set but are in workflow.nodes)
        nodes = workflow.get("nodes", [])
        for n in nodes:
            if n.get("id") == node_id:
                # Found in top-level - this is a subgraph instance node
                search_in_subgraph = False
                break
        else:
            # Not found in top-level - must be inside subgraph definition
            search_in_subgraph = True
    else:
        # No subgraph_id - definitely top-level
        search_in_subgraph = False

    # Search for the node
    if search_in_subgraph:
        # Find in subgraph definition
        definitions = workflow.get("definitions", {})
        subgraphs = definitions.get("subgraphs", [])

        for subgraph in subgraphs:
            if subgraph.get("id") == subgraph_id:
                subgraph_nodes = subgraph.get("nodes", [])
                for n in subgraph_nodes:
                    if n.get("id") == node_id:
                        node = n
                        break
                break
    else:
        # Find in top-level nodes
        nodes = workflow.get("nodes", [])
        for n in nodes:
            if n.get("id") == node_id:
                node = n
                break

    if not node:
        location = f"subgraph {subgraph_id}" if subgraph_id else "top-level"
        logging.warning(f"Node {node_id} not found in {location}")
        return False

    widgets_values = node.get("widgets_values", [])

    if widget_index >= len(widgets_values):
        logging.warning(f"Widget index {widget_index} out of range for node {node_id}")
        return False

    # Get category from resolved_model if not provided
    if not category and resolved_model:
        category = resolved_model.get("category")

    # Check if this is a LoraManager (LoraLoaderV2) node with is_lora_v2 flag
    is_lora_v2 = mapping.get("is_lora_v2") if mapping else False
    original_lora_name = mapping.get("original_lora_name") if mapping else None
    logging.info(
        f"@@ update_model_path: node={node_id}, idx={widget_index}, is_lora_v2={is_lora_v2}, original={original_lora_name}"
    )

    # Special handling for LoraManager nodes: update lora name in lora list
    if is_lora_v2 and original_lora_name and widget_index == 2:
        # For LoraManager, we need to update the name in the lora list (widgets_values[2])
        lora_list = widgets_values[2]
        logging.info(
            f">>> LoraManager: original_lora={original_lora_name}, widget_index={widget_index}, list_type={type(lora_list)}"
        )

        if isinstance(lora_list, list):
            # Get the new lora name from resolved_model
            new_lora_name = None
            if resolved_model:
                # Use filename without extension
                new_lora_name = resolved_model.get("filename") or resolved_model.get(
                    "name", ""
                )
                if new_lora_name:
                    # Remove extension if present
                    if "." in new_lora_name:
                        new_lora_name = new_lora_name.rsplit(".", 1)[0]

            logging.debug(
                f"LoraManager update: original={original_lora_name}, new={new_lora_name}"
            )

            if new_lora_name:
                updated = False
                original_stripped = original_lora_name.strip()

                for lora_item in lora_list:
                    if isinstance(lora_item, dict):
                        lora_name_in_list = lora_item.get("name", "").strip()
                        # Try exact match first, then case-insensitive
                        if lora_name_in_list == original_stripped:
                            lora_item["name"] = new_lora_name
                            updated = True
                            logging.info(
                                f"Updated LoraManager lora (exact): {original_lora_name} -> {new_lora_name}"
                            )
                            break
                        elif lora_name_in_list.lower() == original_stripped.lower():
                            lora_item["name"] = new_lora_name
                            updated = True
                            logging.info(
                                f"Updated LoraManager lora (case-insensitive): {original_lora_name} -> {new_lora_name}"
                            )
                            break

                if updated:
                    # Also update the text widget (widgets_values[1]) which contains formatted lora string
                    if len(widgets_values) > 1 and isinstance(widgets_values[1], str):
                        old_text = widgets_values[1]
                        # Replace the lora name in the text format
                        new_text = old_text.replace(
                            f"<lora:{original_lora_name}:", f"<lora:{new_lora_name}:"
                        )
                        # Also handle case without lora: prefix
                        new_text = new_text.replace(
                            f":{original_lora_name}:", f":{new_lora_name}:"
                        )
                        widgets_values[1] = new_text

                    logging.info(
                        f"Updated node {node_id} LoraManager lora list - new text: {widgets_values[1]}"
                    )
                    return True
                else:
                    # Log the actual lora list for debugging
                    logging.warning(
                        f"Lora '{original_lora_name}' not found in lora list. Available: {[li.get('name') for li in lora_list if isinstance(li, dict)]}"
                    )
                    return False
        else:
            logging.warning(
                f"LoraManager widget_index == 2 but lora_list is not a list: {type(lora_list)}"
            )
            return False

    # Standard handling: convert absolute path to relative path for workflow storage
    # IMPORTANT: Use the category from resolved_model, not the original missing model category
    # This ensures we use the correct category for validation
    if os.path.isabs(resolved_path):
        # Use category from resolved_model for path conversion
        effective_category = category
        if resolved_model:
            effective_category = resolved_model.get("category", category)

        relative_path = convert_to_relative_path(
            resolved_path, effective_category, base_directory
        )
    else:
        relative_path = resolved_path

    # Update the widget value
    # Handle nested dict values (e.g. Power Lora Loader with {"on": true, "lora": "name.safetensors", "strength": 1.0})
    nested_key = mapping.get("nested_key") if mapping else None
    if nested_key and isinstance(widgets_values[widget_index], dict):
        widgets_values[widget_index][nested_key] = relative_path
        logging.debug(
            f"Updated node {node_id}, widget {widget_index}[{nested_key}] to: {relative_path}"
        )
    else:
        widgets_values[widget_index] = relative_path
        logging.debug(
            f"Updated node {node_id}, widget {widget_index} to: {relative_path}"
        )
    return True


def update_workflow_nodes(
    workflow: Dict[str, Any], mappings: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Apply multiple model path changes to a workflow.

    Args:
        workflow: Workflow JSON dictionary (will be modified in place)
        mappings: List of mapping dictionaries:
            {
                'node_id': node ID,
                'widget_index': widget index,
                'resolved_path': absolute path to resolved model,
                'category': model category (optional),
                'base_directory': base directory for category (optional),
                'resolved_model': model dict from scanner (optional, for base_directory)
            }

    Returns:
        Updated workflow dictionary (same reference, modified in place)
    """
    updated_count = 0

    for mapping in mappings:
        node_id = mapping.get("node_id")
        widget_index = mapping.get("widget_index")
        resolved_path = mapping.get("resolved_path")

        if not all([node_id is not None, widget_index is not None, resolved_path]):
            logging.warning(f"Invalid mapping: {mapping}")
            continue

        # Try to get base_directory from resolved_model if provided
        base_directory = mapping.get("base_directory")
        if not base_directory and "resolved_model" in mapping:
            resolved_model = mapping["resolved_model"]
            category = mapping.get("category", "")
            base_directory = get_base_directory_for_model(resolved_model, category)

        category = mapping.get("category")
        resolved_model = mapping.get("resolved_model")
        subgraph_id = mapping.get("subgraph_id")
        is_top_level = mapping.get(
            "is_top_level"
        )  # True for top-level nodes, False for nodes in subgraph definitions
        is_lora_v2 = mapping.get("is_lora_v2")  # Flag for LoraManager nodes
        original_lora_name = mapping.get(
            "original_lora_name"
        )  # Original lora name for replacement

        success = update_model_path(
            workflow,
            node_id,
            widget_index,
            resolved_path,
            category,
            base_directory,
            resolved_model,
            subgraph_id,
            is_top_level,
            mapping,  # Pass full mapping for LoraManager special handling
        )

        if success:
            updated_count += 1

    logging.info(f"Updated {updated_count} model paths in workflow")
    return workflow
