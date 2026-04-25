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

from ..matcher import calculate_similarity_with_normalization, normalize_filename
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

CIVITAI_TYPE_MAP = {
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


def _build_civitai_result_from_version(
    model_id: int,
    model_name: str,
    model_type: str,
    version: Dict[str, Any],
    file_info: Dict[str, Any],
    tags: Optional[List[str]] = None,
    match_type: str = "exact",
) -> Dict[str, Any]:
    """Normalize CivitAI model/version/file data into the search result format."""
    version_id = version.get("id")
    return {
        "source": "civitai",
        "model_id": model_id,
        "version_id": version_id,
        "name": model_name,
        "type": model_type,
        "filename": file_info.get("name", ""),
        "url": f"https://civitai.com/models/{model_id}?modelVersionId={version_id}",
        "download_url": file_info.get("downloadUrl")
        or get_civitai_download_url(version_id),
        "size": file_info.get("sizeKB", 0) * 1024,
        "base_model": version.get("baseModel"),
        "tags": tags or [],
        "match_type": match_type,
    }


def _calculate_filename_confidence(target_filename: str, candidate_filename: str) -> float:
    """Calculate filename confidence using the same normalized approach as local matching."""
    target_norm = normalize_filename(target_filename)
    candidate_norm = normalize_filename(candidate_filename)

    if target_norm == candidate_norm:
        return 100.0

    similarity = calculate_similarity_with_normalization(
        target_filename, candidate_filename
    )
    similarity_no_ext = calculate_similarity_with_normalization(
        os.path.splitext(target_filename)[0], os.path.splitext(candidate_filename)[0]
    )
    return round(max(similarity, similarity_no_ext) * 100, 1)


def _find_matching_file_in_versions(
    versions: List[Dict[str, Any]],
    filename: str,
    exact_only: bool = False,
) -> Optional[Dict[str, Any]]:
    """Search all versions/files for an exact or partial filename match."""
    filename_lower = filename.lower()
    filename_base = os.path.splitext(filename_lower)[0]
    best_match = None
    best_confidence = 0.0

    for version in versions:
        version_id = version.get("id")
        files = version.get("files", [])
        log_debug(
            f"CivitAI checking version_id={version_id} with {len(files)} files"
        )

        for file_info in files:
            file_name = file_info.get("name", "")
            if not file_name:
                continue

            file_name_lower = file_name.lower()
            file_base = os.path.splitext(file_name_lower)[0]

            if file_name_lower == filename_lower:
                return {"version": version, "file_info": file_info, "match_type": "exact"}

            if not exact_only and (
                filename_base in file_base or file_base in filename_base
            ):
                return {
                    "version": version,
                    "file_info": file_info,
                    "match_type": "partial",
                }

            if not exact_only:
                confidence = _calculate_filename_confidence(filename, file_name)
                if confidence > best_confidence:
                    best_confidence = confidence
                    best_match = {
                        "version": version,
                        "file_info": file_info,
                        "match_type": "similar",
                        "confidence": confidence,
                    }

    if best_match and best_confidence >= 50.0:
        return best_match

    return None


def _extract_civitai_red_candidates(html: str, limit: int = 5) -> List[Dict[str, int]]:
    """Extract model/version candidates from civitai.red search results HTML."""
    candidates: List[Dict[str, int]] = []
    seen = set()

    for match in re.finditer(r"/models/(\d+)(?:\?modelVersionId=(\d+))?", html):
        model_id = int(match.group(1))
        version_id = int(match.group(2)) if match.group(2) else None
        key = (model_id, version_id)
        if key in seen:
            continue
        seen.add(key)
        candidates.append({"model_id": model_id, "version_id": version_id})
        if len(candidates) >= limit:
            break

    return candidates


def _extract_trpc_model_candidates(
    payload: Any, limit: int = 5
) -> List[Dict[str, Optional[int]]]:
    """Extract model/version candidates from a tRPC JSON response."""
    candidates: List[Dict[str, Optional[int]]] = []
    seen = set()

    items = (
        payload.get("result", {})
        .get("data", {})
        .get("json", {})
        .get("items", [])
    )

    if not isinstance(items, list):
        return candidates

    for item in items:
        if not isinstance(item, dict):
            continue

        model_id = item.get("id")
        version = item.get("version", {})
        version_id = version.get("id") if isinstance(version, dict) else None

        if not isinstance(model_id, int):
            continue

        key = (model_id, version_id if isinstance(version_id, int) else None)
        if key in seen:
            continue

        seen.add(key)
        candidates.append(
            {
                "model_id": model_id,
                "version_id": version_id if isinstance(version_id, int) else None,
            }
        )

        if len(candidates) >= limit:
            break

    return candidates


def _search_civitai_trpc_candidates(
    filename: str,
    model_type: Optional[str] = None,
    timeout: int = 15,
    limit: int = 5,
) -> List[Dict[str, Optional[int]]]:
    """Try CivitAI.red tRPC search endpoint and log the raw outcome for diagnostics."""
    input_payload = {
        "json": {
            "period": "Month",
            "periodMode": "stats",
            "sort": "Highest Rated",
            "query": filename,
            "pending": False,
            "browsingLevel": 28,
            "excludedTagIds": [
                415792,
                426772,
                5351,
                5161,
                5162,
                5188,
                5249,
                306619,
                5351,
                154326,
                161829,
                163032,
                130818,
                130820,
                133182,
            ],
            "disablePoi": True,
            "disableMinor": True,
            "limit": limit,
            "authed": True,
        },
        "meta": {"values": {"cursor": ["undefined"]}},
    }
    civitai_type = CIVITAI_TYPE_MAP.get(str(model_type).lower()) if model_type else None
    if civitai_type:
        input_payload["json"]["types"] = [civitai_type]

    url = (
        "https://civitai.red/api/trpc/model.getAll?input="
        + quote(json.dumps(input_payload, separators=(",", ":")))
    )
    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "referer": f"https://civitai.red/models?query={quote(filename)}",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/147.0.0.0 Safari/537.36"
        ),
        "x-client": "web",
        "x-client-version": "5.0.1657",
    }

    log_info(
        f"CivitAI tRPC search start: filename={filename}, model_type={model_type}, url={url}"
    )

    try:
        response = requests.get(url, headers=headers, timeout=timeout)
    except Exception as e:
        log_warn(f"CivitAI tRPC request failed for filename={filename}: {e}")
        return []

    text_preview = response.text[:800].replace("\n", " ").replace("\r", " ")
    log_info(
        f"CivitAI tRPC response: status={response.status_code}, content_type={response.headers.get('content-type')}, text_preview={text_preview}"
    )

    if response.status_code != 200:
        return []

    try:
        payload = response.json()
    except Exception as e:
        log_warn(f"CivitAI tRPC JSON parse failed for filename={filename}: {e}")
        return []

    candidates = _extract_trpc_model_candidates(payload, limit=limit)
    log_info(
        f"CivitAI tRPC extracted {len(candidates)} candidates for filename={filename}: {candidates}"
    )
    return candidates


def _search_civitai_red_candidates(
    filename: str, timeout: int = 15, limit: int = 5
) -> List[Dict[str, int]]:
    """Search civitai.red by full filename and return model/version candidates."""
    search_url = f"https://civitai.red/models?query={quote(filename)}"
    log_info(f"CivitAI.red search start: filename={filename}, url={search_url}")

    response = requests.get(search_url, timeout=timeout)
    if response.status_code != 200:
        log_warn(
            f"CivitAI.red search returned {response.status_code} for filename={filename}"
        )
        return []

    candidates = _extract_civitai_red_candidates(response.text, limit=limit)
    log_info(
        f"CivitAI.red search extracted {len(candidates)} candidates for filename={filename}"
    )
    return candidates


def _find_civitai_file_in_model(
    model_id: int,
    filename: str,
    api_key: Optional[str] = None,
    exact_only: bool = False,
    preferred_version_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Load one CivitAI model and search all its versions for the requested file."""
    filename_lower = filename.lower()
    filename_base = os.path.splitext(filename_lower)[0]

    def build_result_from_resolved_version(
        resolved: Dict[str, Any], version_id: int
    ) -> Dict[str, Any]:
        expected_filename = resolved.get("expected_filename", "")
        primary_file = None
        for file_info in resolved.get("files", []):
            if file_info.get("name") == expected_filename:
                primary_file = file_info
                break
        if primary_file is None:
            primary_file = (resolved.get("files") or [{}])[0]

        return {
            "source": "civitai",
            "model_id": model_id,
            "version_id": version_id,
            "name": resolved.get("model_name", ""),
            "type": "",
            "filename": expected_filename,
            "url": f"https://civitai.com/models/{model_id}?modelVersionId={version_id}",
            "download_url": get_civitai_download_url(version_id, api_key),
            "size": primary_file.get("size"),
            "base_model": resolved.get("base_model"),
            "tags": resolved.get("tags", []),
            "match_type": "exact",
            "confidence": _calculate_filename_confidence(
                filename, expected_filename
            ),
        }

    def resolved_version_matches(resolved: Dict[str, Any]) -> bool:
        expected_filename = str(resolved.get("expected_filename", "")).lower()
        expected_base = os.path.splitext(expected_filename)[0]
        log_debug(
            f"CivitAI resolved version filename check: expected_filename={resolved.get('expected_filename')}, target_filename={filename}"
        )
        if expected_filename == filename_lower:
            return True
        if not exact_only and (
            filename_base in expected_base or expected_base in filename_base
        ):
            return True
        return False

    if preferred_version_id is not None:
        resolved = resolve_urn(model_id, preferred_version_id, api_key)
        if resolved:
            if resolved_version_matches(resolved):
                return build_result_from_resolved_version(resolved, preferred_version_id)

    best_resolved_result = None
    best_resolved_confidence = 0.0

    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    response = requests.get(
        f"{CIVITAI_API_URL}/models/{model_id}", headers=headers, timeout=15
    )
    if response.status_code != 200:
        log_warn(f"CivitAI model lookup returned {response.status_code} for model_id={model_id}")
        return None

    data = response.json()
    versions = data.get("modelVersions", [])
    if preferred_version_id is not None:
        preferred = [v for v in versions if v.get("id") == preferred_version_id]
        others = [v for v in versions if v.get("id") != preferred_version_id]
        versions = preferred + others

    log_debug(
        f"CivitAI model lookup model_id={model_id} returned {len(versions)} versions"
    )

    for version in versions:
        version_id = version.get("id")
        if not version_id:
            continue

        resolved = resolve_urn(model_id, version_id, api_key)
        if resolved:
            if resolved_version_matches(resolved):
                return build_result_from_resolved_version(resolved, version_id)

            if not exact_only:
                expected_filename = resolved.get("expected_filename", "")
                confidence = _calculate_filename_confidence(filename, expected_filename)
                log_debug(
                    f"CivitAI resolved version confidence: model_id={model_id}, version_id={version_id}, expected_filename={expected_filename}, confidence={confidence}"
                )
                if confidence > best_resolved_confidence:
                    best_resolved_confidence = confidence
                    best_resolved_result = build_result_from_resolved_version(
                        resolved, version_id
                    )
                    best_resolved_result["match_type"] = "similar"
                    best_resolved_result["confidence"] = confidence

        files = version.get("files", [])
        file_names = [f.get("name", "") for f in files if isinstance(f, dict)]
        log_debug(
            f"CivitAI version file names: model_id={model_id}, version_id={version_id}, files={file_names}"
        )

    if best_resolved_result and best_resolved_confidence >= 50.0:
        log_info(
            f"CivitAI best probable match: model_id={model_id}, version_id={best_resolved_result.get('version_id')}, filename={best_resolved_result.get('filename')}, confidence={best_resolved_confidence}"
        )
        return best_resolved_result

    match = _find_matching_file_in_versions(versions, filename, exact_only=exact_only)
    if match:
        version = match["version"]
        file_info = match["file_info"]
        result = _build_civitai_result_from_version(
            model_id=model_id,
            model_name=data.get("name", ""),
            model_type=data.get("type", ""),
            version=version,
            file_info=file_info,
            tags=data.get("tags", []),
            match_type=match["match_type"],
        )
        result["confidence"] = match.get(
            "confidence",
            _calculate_filename_confidence(filename, result.get("filename", "")),
        )
        if match["match_type"] == "similar":
            log_info(
                f"CivitAI version-list probable match: model_id={model_id}, version_id={result.get('version_id')}, filename={result.get('filename')}, confidence={result['confidence']}"
            )
        return result

    return None


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


def search_civitai_for_file(
    filename: str,
    api_key: Optional[str] = None,
    exact_only: bool = False,
    model_type: Optional[str] = None,
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
        log_debug(f"CivitAI search cache hit for {filename} (exact_only={exact_only})")
        return _search_cache[cache_key]

    try:
        # Prefer the CivitAI.red tRPC search because it is much closer to what
        # the browser search UI returns than the broad public /models API.
        trpc_candidates = _search_civitai_trpc_candidates(
            filename, model_type=model_type
        )
        for candidate in trpc_candidates:
            model_id = candidate["model_id"]
            version_id = candidate.get("version_id")
            log_info(
                f"CivitAI tRPC candidate check: model_id={model_id}, preferred_version_id={version_id}, filename={filename}"
            )
            result = _find_civitai_file_in_model(
                model_id=model_id,
                filename=filename,
                api_key=api_key,
                exact_only=exact_only,
                preferred_version_id=version_id,
            )
            if result:
                _search_cache[cache_key] = result
                log_info(
                    f"Found {filename} via CivitAI tRPC fallback: model_id={result.get('model_id')}, version_id={result.get('version_id')}"
                )
                return result

        # Fallback: civitai.red HTML search, then inspect all submodels/versions
        candidates = _search_civitai_red_candidates(filename)
        for candidate in candidates:
            model_id = candidate["model_id"]
            version_id = candidate.get("version_id")
            log_info(
                f"CivitAI.red candidate check: model_id={model_id}, preferred_version_id={version_id}, filename={filename}"
            )
            result = _find_civitai_file_in_model(
                model_id=model_id,
                filename=filename,
                api_key=api_key,
                exact_only=exact_only,
                preferred_version_id=version_id,
            )
            if result:
                _search_cache[cache_key] = result
                log_info(
                    f"Found {filename} via CivitAI.red fallback: model_id={result.get('model_id')}, version_id={result.get('version_id')}"
                )
                return result

        # Not found
        _search_cache[cache_key] = None
        log_info(
            f"CivitAI search no result: filename={filename}, trpc_candidates={len(trpc_candidates)}, html_candidates={len(candidates) if 'candidates' in locals() else 0}"
        )
        return None

    except Exception as e:
        log_exception(f"CivitAI search error for {filename}: {e}")
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
