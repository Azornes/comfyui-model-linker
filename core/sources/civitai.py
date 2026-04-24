"""
CivitAI Source Module

Search and download models from CivitAI.
"""

import os
import re
import json
import hashlib
import requests
from typing import Dict, Any, Optional, List
from urllib.parse import urlparse, parse_qs, quote

from ..log_system.log_funcs import (
    log_debug,
    log_info,
    log_warn,
    log_error,
    log_exception,
)

CIVITAI_API_URL = "https://civitai.com/api/v1"

# Cache for search results and URN resolutions
_search_cache: Dict[str, Any] = {}
_urn_cache: Dict[tuple[int, int], Dict[str, Any]] = {}
_hash_cache: Dict[str, Dict[str, Any]] = {}


def _extract_civitai_image_id(image_url: str) -> Optional[str]:
    """
    Extract a CivitAI image ID from an image CDN URL.
    Example:
    https://image.civitai.com/.../width=1800/1917130.jpeg -> 1917130
    """
    if not image_url:
        return None

    match = re.search(r"/(\d+)(?:\.[A-Za-z0-9]+)?(?:[?#].*)?$", image_url)
    if match:
        return match.group(1)

    return None


def _build_civitai_image_url(img: Dict[str, Any]) -> str:
    """
    Build a stable CivitAI image page URL from available image metadata.
    """
    civitai_url = img.get("civitaiUrl")
    if civitai_url:
        return civitai_url

    image_id = img.get("id")
    if image_id is not None:
        return f"https://civitai.com/images/{image_id}"

    extracted_id = _extract_civitai_image_id(img.get("url", ""))
    if extracted_id:
        return f"https://civitai.com/images/{extracted_id}"

    return ""


def parse_civitai_url(url: str) -> Optional[Dict[str, Any]]:
    """
    Parse a CivitAI URL to extract model/version info.
    """
    parsed = urlparse(url)
    if "civitai.com" not in parsed.netloc:
        return None

    if "/api/download/models/" in parsed.path:
        match = re.search(r"/api/download/models/(\d+)", parsed.path)
        if match:
            return {"version_id": int(match.group(1))}

    match = re.search(r"/models/(\d+)", parsed.path)
    if match:
        result = {"model_id": int(match.group(1))}
        query = parse_qs(parsed.query)
        if "modelVersionId" in query:
            result["version_id"] = int(query["modelVersionId"][0])
        return result

    return None


def get_civitai_download_url(version_id: int, api_key: Optional[str] = None) -> str:
    """Get download URL for a CivitAI model version."""
    url = f"https://civitai.com/api/download/models/{version_id}"
    if api_key:
        url += f"?token={api_key}"
    return url


def clean_filename_for_search(filename: str) -> str:
    """
    Clean up filename for better CivitAI search results.
    Remove common suffixes that might prevent matches.
    """
    base = os.path.splitext(filename)[0]
    # Remove common precision/format suffixes
    base = re.sub(
        r"[-_]?(fp16|fp32|fp8|bf16|e4m3fn|scaled|pruned|emaonly|q4|q8).*$",
        "",
        base,
        flags=re.IGNORECASE,
    )
    # Remove version numbers at end
    base = re.sub(r"[-_]?v?\d+(\.\d+)*$", "", base, flags=re.IGNORECASE)
    return base


def search_civitai_for_file(
    filename: str, api_key: Optional[str] = None, exact_only: bool = False
) -> Optional[Dict[str, Any]]:
    """
    Search CivitAI for a specific model file.
    Returns the first model that actually has this exact filename.

    Args:
        filename: Exact filename to search for
        api_key: Optional API key
        exact_only: If True, only return exact filename matches (for downloads).
                   If False, also try partial matching (for local file resolution).

    Returns:
        Dict with download info if found, None otherwise
    """
    global _search_cache

    cache_key = f"civit_{filename}_exact{exact_only}"
    if cache_key in _search_cache:
        return _search_cache[cache_key]

    try:
        # Clean filename for search
        search_term = clean_filename_for_search(filename)

        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        search_url = f"{CIVITAI_API_URL}/models?query={quote(search_term)}&limit=10"

        response = requests.get(search_url, headers=headers, timeout=15)
        if response.status_code != 200:
            log_debug(f"CivitAI search returned {response.status_code}")
            return None

        data = response.json()
        items = data.get("items", [])

        filename_base = os.path.splitext(filename.lower())[0]

        for item in items:
            model_id = item.get("id")
            model_name = item.get("name", "")
            model_type = item.get("type", "")

            model_versions = item.get("modelVersions", [])
            for version in model_versions:
                version_id = version.get("id")
                files = version.get("files", [])

                for file_info in files:
                    file_name = file_info.get("name", "")
                    file_base = os.path.splitext(file_name.lower())[0]

                    # Check for exact filename match (case-insensitive) - always try this
                    if file_name.lower() == filename.lower():
                        download_url = file_info.get("downloadUrl", "")
                        if download_url:
                            result = {
                                "source": "civitai",
                                "model_id": model_id,
                                "version_id": version_id,
                                "name": model_name,
                                "type": model_type,
                                "filename": file_name,
                                "url": f"https://civitai.com/models/{model_id}",
                                "download_url": download_url,
                                "size": file_info.get("sizeKB", 0) * 1024,
                                "base_model": version.get("baseModel"),
                                "tags": item.get("tags", []),
                                "match_type": "exact",
                            }
                            _search_cache[cache_key] = result
                            log_info(f"Found {filename} on CivitAI: {model_name}")
                            return result

                    # Check for partial match (filename_base in file_base or vice versa)
                    # Skip partial matches if exact_only is True - prevents confusing
                    # users with wrong model suggestions for downloads
                    if not exact_only:
                        if filename_base in file_base or file_base in filename_base:
                            download_url = file_info.get("downloadUrl", "")
                            if download_url:
                                result = {
                                    "source": "civitai",
                                    "model_id": model_id,
                                    "version_id": version_id,
                                    "name": model_name,
                                    "type": model_type,
                                    "filename": file_name,
                                    "url": f"https://civitai.com/models/{model_id}",
                                    "download_url": download_url,
                                    "size": file_info.get("sizeKB", 0) * 1024,
                                    "base_model": version.get("baseModel"),
                                    "tags": item.get("tags", []),
                                    "match_type": "partial",
                                }
                                _search_cache[cache_key] = result
                                log_info(
                                    f"Found similar file for {filename} on CivitAI: {model_name}"
                                )
                                return result

        # Not found
        _search_cache[cache_key] = None
        return None

    except Exception as e:
        log_error(f"CivitAI search error: {e}")
        return None


def search_civitai(
    query: str,
    model_type: Optional[str] = None,
    limit: int = 10,
    api_key: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Search CivitAI for models (general search).
    Returns models that might be relevant.
    """
    results = []

    type_map = {
        "checkpoint": "Checkpoint",
        "checkpoints": "Checkpoint",
        "lora": "LORA",
        "loras": "LORA",
        "vae": "VAE",
        "controlnet": "Controlnet",
        "embedding": "TextualInversion",
        "embeddings": "TextualInversion",
        "upscaler": "Upscaler",
        "upscale_models": "Upscaler",
    }

    try:
        params = {"query": query, "limit": limit, "nsfw": "false"}

        if model_type:
            civitai_type = type_map.get(model_type.lower())
            if civitai_type:
                params["types"] = civitai_type

        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        response = requests.get(
            f"{CIVITAI_API_URL}/models", params=params, headers=headers, timeout=15
        )

        if response.status_code == 200:
            data = response.json()

            for model in data.get("items", []):
                model_id = model.get("id")
                model_name = model.get("name", "")
                model_type = model.get("type", "")

                versions = model.get("modelVersions", [])
                if versions:
                    latest = versions[0]
                    version_id = latest.get("id")

                    files = latest.get("files", [])
                    primary_file = None
                    for f in files:
                        if f.get("primary", False) or f.get("type") == "Model":
                            primary_file = f
                            break

                    if not primary_file and files:
                        primary_file = files[0]

                    result = {
                        "source": "civitai",
                        "model_id": model_id,
                        "version_id": version_id,
                        "name": model_name,
                        "type": model_type,
                        "url": f"https://civitai.com/models/{model_id}",
                        "download_url": get_civitai_download_url(version_id, api_key),
                        "downloads": model.get("stats", {}).get("downloadCount", 0),
                        "base_model": latest.get("baseModel"),
                        "tags": model.get("tags", []),
                    }

                    if primary_file:
                        result["filename"] = primary_file.get("name", "")
                        result["size"] = primary_file.get("sizeKB", 0) * 1024

                    results.append(result)

    except Exception as e:
        log_error(f"CivitAI search error: {e}")

    return results


def search_civitai_by_hash(
    hash_value: str, api_key: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Look up a model by file hash on CivitAI."""
    try:
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        response = requests.get(
            f"{CIVITAI_API_URL}/model-versions/by-hash/{hash_value}",
            headers=headers,
            timeout=15,
        )

        if response.status_code == 200:
            data = response.json()

            model_id = data.get("modelId")
            version_id = data.get("id")
            files = data.get("files", [])
            primary_file = files[0] if files else {}

            return {
                "source": "civitai",
                "model_id": model_id,
                "version_id": version_id,
                "name": data.get("model", {}).get("name", ""),
                "url": f"https://civitai.com/models/{model_id}",
                "download_url": get_civitai_download_url(version_id, api_key),
                "filename": primary_file.get("name", ""),
                "size": primary_file.get("sizeKB", 0) * 1024,
            }

    except Exception as e:
        log_error(f"CivitAI hash lookup error: {e}")

    return None


def resolve_urn(
    model_id: int, version_id: int, api_key: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Resolve URN model_id/version_id to model info and expected filename.

    Args:
        model_id: CivitAI model ID
        version_id: CivitAI version ID
        api_key: Optional API key

    Returns:
        Dict with model name and primary filename, or None
    """
    cache_key = (model_id, version_id)
    if cache_key in _urn_cache:
        return _urn_cache[cache_key]

    try:
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        url = f"{CIVITAI_API_URL}/models/{model_id}"
        params = {"modelVersionId": version_id}

        response = requests.get(url, headers=headers, params=params, timeout=15)

        if response.status_code != 200:
            log_warn(f"CivitAI URN resolve failed: {response.status_code}")
            _urn_cache[cache_key] = None
            return None

        data = response.json()
        versions = data.get("modelVersions", [])

        if not versions:
            log_warn(f"No versions found for model {model_id}/version {version_id}")
            _urn_cache[cache_key] = None
            return None

        # Get specific version
        target_version = None
        for v in versions:
            if v.get("id") == version_id:
                target_version = v
                break

        if not target_version:
            log_warn(f"Version {version_id} not found in model {model_id}")
            _urn_cache[cache_key] = None
            return None

        files = target_version.get("files", [])
        primary_file = None

        # Prefer primary file or type=='Model'
        for f in files:
            if f.get("primary") or f.get("type") == "Model":
                primary_file = f
                break

        if not primary_file and files:
            primary_file = files[0]  # Fallback to first

        if not primary_file:
            log_warn(f"No files found for version {version_id}")
            _urn_cache[cache_key] = None
            return None

        result = {
            "model_name": data.get("name", "Unknown"),
            "version_name": target_version.get("name", "Unknown"),
            "expected_filename": primary_file.get("name", "Unknown"),
            "base_model": target_version.get("baseModel"),
            "tags": data.get("tags", []),
            "files": [
                {"name": f.get("name"), "size": f.get("sizeKB", 0) * 1024}
                for f in files
            ],
        }

        _urn_cache[cache_key] = result
        log_info(
            f"Resolved URN model {model_id}@{version_id} → {result['expected_filename']}"
        )
        return result

    except Exception as e:
        log_error(f"CivitAI URN resolve error for {model_id}@{version_id}: {e}")
        _urn_cache[cache_key] = None
        return None


def _get_sha256_hash(file_path: str) -> Optional[str]:
    """
    Compute sha256 hash of a file by reading it in chunks.

    Args:
        file_path: Full path to the file

    Returns:
        SHA256 hash as hex string, or None if file doesn't exist
    """
    if not file_path or not os.path.exists(file_path):
        return None

    BUF_SIZE = 1024 * 128  # 128KB chunks
    sha256_hash = hashlib.sha256()

    try:
        with open(file_path, "rb") as f:
            for byte_block in iter(lambda: f.read(BUF_SIZE), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except Exception as e:
        log_error(f"Error computing hash for {file_path}: {e}")
        return None


def get_model_info_by_hash(
    file_hash: str, api_key: Optional[str] = None, use_cache: bool = True
) -> Optional[Dict[str, Any]]:
    """
    Look up a model on CivitAI using its sha256 hash.
    Uses the CivitAI API endpoint: /api/v1/model-versions/by-hash/{hash}

    Args:
        file_hash: SHA256 hash of the model file
        api_key: Optional CivitAI API key
        use_cache: Whether to use cached results

    Returns:
        Dict with model info from CivitAI, or None if not found
    """
    global _hash_cache

    if not file_hash:
        return None

    cache_key = f"hash_{file_hash}"

    if use_cache and cache_key in _hash_cache:
        return _hash_cache[cache_key]

    api_url = f"{CIVITAI_API_URL}/model-versions/by-hash/{file_hash}"

    try:
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        response = requests.get(api_url, headers=headers, timeout=15)

        if response.status_code == 200:
            data = response.json()

            # Extract useful info from the response
            model_info = data.get("model", {})
            version_info = data

            # Get model_id from top level or nested model object
            model_id = data.get("modelId") or model_info.get("id")

            # Extract images with metadata
            images = _extract_model_images(version_info)

            result = {
                "source": "civitai",
                "model_id": model_id,
                "model_name": model_info.get("name"),
                "model_type": model_info.get("type"),
                "version_id": version_info.get("id"),
                "version_name": version_info.get("name"),
                "sha256": file_hash,
                "url": f"https://civitai.com/models/{model_id}" if model_id else None,
                "version_url": f"https://civitai.com/models/{model_id}?modelVersionId={version_info.get('id')}"
                if model_id
                else None,
                "download_url": version_info.get("downloadUrl"),
                "base_model": version_info.get("baseModel"),
                "tags": model_info.get("tags", []),
                "trained_words": _extract_trained_words(version_info),
                "images": images,
                "clip_skip": version_info.get("clipSkip"),
                "description": version_info.get("description", ""),
                "model_description": model_info.get("description", ""),
            }

            _hash_cache[cache_key] = result
            log_info(f"Found model by hash {file_hash}: {result.get('model_name')}")
            return result

        elif response.status_code == 404:
            log_info(f"Model not found on CivitAI for hash {file_hash}")
            _hash_cache[cache_key] = None
            return None
        else:
            log_warn(
                f"CivitAI hash lookup returned {response.status_code} for {file_hash}"
            )
            return None

    except Exception as e:
        log_error(f"Error looking up model by hash {file_hash}: {e}")
        return None

    cache_key = f"hash_{file_hash}"

    if use_cache and cache_key in _hash_cache:
        return _hash_cache[cache_key]

    api_url = f"{CIVITAI_API_URL}/model-versions/by-hash/{file_hash}"

    try:
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        response = requests.get(api_url, headers=headers, timeout=15)

        if response.status_code == 200:
            data = response.json()

            # Extract useful info from the response
            model_info = data.get("model", {})
            version_info = data

            # Get model_id from top level or nested model object
            model_id = data.get("modelId") or model_info.get("id")

            # Extract images with metadata
            images = _extract_model_images(version_info)

            result = {
                "source": "civitai",
                "model_id": model_id,
                "model_name": model_info.get("name"),
                "model_type": model_info.get("type"),
                "version_id": version_info.get("id"),
                "version_name": version_info.get("name"),
                "sha256": file_hash,
                "url": f"https://civitai.com/models/{model_id}" if model_id else None,
                "version_url": f"https://civitai.com/models/{model_id}?modelVersionId={version_info.get('id')}"
                if model_id
                else None,
                "download_url": version_info.get("downloadUrl"),
                "base_model": version_info.get("baseModel"),
                "tags": model_info.get("tags", []),
                "trained_words": _extract_trained_words(version_info),
                "images": images,
                "clip_skip": version_info.get("clipSkip"),
                "description": version_info.get("description", ""),
                "model_description": model_info.get("description", ""),
            }

            _hash_cache[cache_key] = result
            log_info(f"Found model by hash {file_hash}: {result.get('model_name')}")
            return result

        elif response.status_code == 404:
            log_info(f"Model not found on CivitAI for hash {file_hash}")
            _hash_cache[cache_key] = None
            return None
        else:
            log_warn(
                f"CivitAI hash lookup returned {response.status_code} for {file_hash}"
            )
            return None

    except Exception as e:
        log_error(f"Error looking up model by hash {file_hash}: {e}")
        return None


def _extract_trained_words(version_info: Dict[str, Any]) -> List[str]:
    """
    Extract trained words/phrases from model version info.
    """
    trained_words = []

    # Try to get from metadata
    metadata = version_info.get("trainedWords", [])
    if isinstance(metadata, list):
        trained_words.extend(metadata)
    elif isinstance(metadata, str) and metadata:
        trained_words.append(metadata)

    # Also check metadata field
    model = version_info.get("model", {})
    if isinstance(model, dict):
        model_tags = model.get("tags", [])
        if isinstance(model_tags, list):
            for tag in model_tags:
                if tag not in trained_words:
                    trained_words.append(tag)

    return trained_words


def _extract_model_images(version_info: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Extract images with metadata from model version info.
    Each image can have: url, civitaiUrl, seed, steps, cfg, sampler, model, positive, negative
    """
    images = []

    # Get images from modelVersions or direct images field
    images_data = version_info.get("images", [])
    if not images_data:
        # Check nested modelVersions
        model_versions = version_info.get("modelVersions", [])
        if model_versions and len(model_versions) > 0:
            images_data = model_versions[0].get("images", [])

    for img in images_data:
        if not isinstance(img, dict):
            continue

        # Get the image URL
        img_url = img.get("url", "")
        if not img_url:
            continue

        # Get metadata from image info (may be nested in 'meta' object)
        meta = img.get("meta", {})

        img_info = {
            "url": img_url,
            "civitaiUrl": _build_civitai_image_url(img),
            "seed": img.get("seed") or meta.get("seed"),
            "steps": img.get("steps") or meta.get("steps"),
            "cfg": img.get("cfg") or meta.get("cfg"),
            "sampler": img.get("sampler") or meta.get("sampler"),
            "model": img.get("model") or meta.get("model"),
            "positive": img.get("positive") or meta.get("prompt"),
            "negative": img.get("negative") or meta.get("negative_prompt"),
        }

        # Only add if we have at least a URL
        if img_info["url"]:
            images.append(img_info)

    return images


def _get_metadata_file_path(model_path: str) -> str:
    """
    Get the path to the metadata file for a model.
    For example, for 'model.safetensors', it returns 'model.metadata.json'
    Also checks for variations without extension or with different extensions.
    """
    if not model_path:
        return ""

    # Get directory and filename
    directory = os.path.dirname(model_path)
    filename = os.path.basename(model_path)

    # Try different variations of the metadata file name
    base_name = filename.rsplit(".", 1)[0] if "." in filename else filename

    possible_names = [
        base_name + ".metadata.json",
        filename + ".metadata.json",
        base_name + ".json",
        filename.replace("_", " ").split()[0] + ".metadata.json"
        if "_" in base_name
        else None,
    ]

    for name in possible_names:
        if name:
            path = os.path.join(directory, name)
            if os.path.exists(path):
                log_info(f"Found metadata file: {path}")
                return path

    return ""


def _read_model_metadata(metadata_path: str) -> Optional[Dict[str, Any]]:
    """
    Read model metadata from a JSON file.
    Returns the metadata if found and valid, None otherwise.
    """
    if not metadata_path or not os.path.exists(metadata_path):
        return None

    try:
        with open(metadata_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Validate it's a valid metadata file with CivitAI info
        if not isinstance(data, dict):
            return None

        # Check if it has the needed info
        if not data.get("sha256") and not data.get("civitai"):
            return None

        log_info(f"Successfully read metadata from: {metadata_path}")
        return data
    except Exception as e:
        log_debug(f"Error reading metadata file {metadata_path}: {e}")
        return None


def _metadata_to_model_info(metadata: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert metadata file format to model info format used by our extension.
    """
    civitai_data = metadata.get("civitai") or {}

    # Extract images with metadata
    images = []
    for img in civitai_data.get("images") or []:
        if isinstance(img, dict) and img.get("url"):
            img_meta = img.get("meta") or {}
            images.append(
                {
                    "url": img.get("url", ""),
                    "civitaiUrl": _build_civitai_image_url(img),
                    "seed": img_meta.get("seed"),
                    "steps": img_meta.get("steps"),
                    "cfg": img_meta.get("cfg"),
                    "sampler": img_meta.get("sampler"),
                    "positive": img_meta.get("prompt"),
                }
            )

    # Get trained words from CivitAI data
    trained_words = civitai_data.get("trainedWords") or []
    if isinstance(trained_words, str):
        trained_words = [trained_words] if trained_words else []

    # Get model info
    model_info = civitai_data.get("model") or {}
    version_info = civitai_data

    # Build model_id from CivitAI data
    model_id = civitai_data.get("modelId") or civitai_data.get("id")

    return {
        "source": "metadata",
        "model_id": model_id,
        "model_name": metadata.get("model_name") or metadata.get("file_name", ""),
        "model_type": model_info.get("type", "") or civitai_data.get("type", ""),
        "version_id": civitai_data.get("id"),
        "version_name": civitai_data.get("name", ""),
        "sha256": metadata.get("sha256", ""),
        "url": f"https://civitai.com/models/{civitai_data.get('modelId')}"
        if civitai_data.get("modelId")
        else None,
        "version_url": f"https://civitai.com/models/{civitai_data.get('modelId')}?modelVersionId={civitai_data.get('id')}"
        if model_id
        else None,
        "download_url": civitai_data.get("downloadUrl"),
        "base_model": (metadata.get("base_model") or civitai_data.get("baseModel", "")),
        "tags": metadata.get("tags") or [],
        "trained_words": trained_words,
        "images": images,
        "clip_skip": civitai_data.get("clipSkip"),
        "description": metadata.get("model_description", "")
        or civitai_data.get("description", ""),
        "model_description": metadata.get("model_description", ""),
        "from_metadata": True,
    }


def get_model_info_for_file(
    file_path: str, api_key: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Get model info from CivitAI by computing file hash and looking up by hash.
    First checks if there's a metadata file in the same folder.

    Args:
        file_path: Full path to the model file
        api_key: Optional CivitAI API key

    Returns:
        Dict with model info from CivitAI, or None if not found
    """
    log_info(f"get_model_info_for_file called with: {file_path}")

    # First check for metadata file
    metadata_path = _get_metadata_file_path(file_path)
    log_info(f"Looking for metadata file, checked: {metadata_path}")

    if metadata_path:
        metadata = _read_model_metadata(metadata_path)
        if metadata:
            log_info(f"Using metadata file for {file_path}")
            return _metadata_to_model_info(metadata)
    else:
        # Debug: list all files in the same directory
        directory = os.path.dirname(file_path)
        if directory and os.path.exists(directory):
            files = os.listdir(directory)
            metadata_files = [
                f for f in files if "metadata" in f.lower() or f.endswith(".json")
            ]
            log_info(f"Files in {directory}: {metadata_files}")

    # If no metadata file, compute hash and look up on CivitAI
    file_hash = _get_sha256_hash(file_path)
    if not file_hash:
        return None

    return get_model_info_by_hash(file_hash, api_key)
