"""
Fuzzy Matcher Module

Implements fuzzy string matching to find similar model names.
"""

import os
import re
from typing import List, Dict, Tuple
from difflib import SequenceMatcher

from .log_system.log_funcs import log_debug, log_info, log_warn, log_error, log_exception


def normalize_filename(filename: str) -> str:
    """
    Normalize a filename for comparison.

    Removes file extension, converts to lowercase, and normalizes
    separators (underscores, hyphens, spaces).

    Args:
        filename: Filename to normalize

    Returns:
        Normalized string for comparison
    """
    # Remove file extension
    base = os.path.splitext(filename)[0]

    # Convert to lowercase
    base = base.lower()

    # Normalize separators: replace underscores, hyphens, and spaces with a single space
    base = re.sub(r"[_\-\s]+", " ", base)

    # Strip whitespace
    base = base.strip()

    return base


def calculate_similarity(str1: str, str2: str) -> float:
    """
    Calculate similarity score between two strings (0.0 to 1.0).

    Uses SequenceMatcher to compute a ratio.

    Args:
        str1: First string
        str2: Second string

    Returns:
        Similarity score from 0.0 (completely different) to 1.0 (identical)
    """
    return SequenceMatcher(None, str1, str2).ratio()


def calculate_similarity_with_normalization(str1: str, str2: str) -> float:
    """
    Calculate similarity score with filename normalization.

    Normalizes both strings before comparing.

    Args:
        str1: First string (typically model filename)
        str2: Second string (typically candidate model filename)

    Returns:
        Similarity score from 0.0 to 1.0
    """
    norm1 = normalize_filename(str1)
    norm2 = normalize_filename(str2)
    return calculate_similarity(norm1, norm2)


def find_matches(
    target_model: str,
    candidate_models: List[Dict[str, str]],
    threshold: float = 0.0,
    max_results: int = 10,
) -> List[Dict[str, any]]:
    """
    Find similar models using fuzzy matching.

    Args:
        target_model: The target model filename/path to match
        candidate_models: List of candidate model dictionaries with 'filename' or 'path' key
        threshold: Minimum similarity score (0.0 to 1.0) to include in results
        max_results: Maximum number of results to return

    Returns:
        List of match dictionaries sorted by similarity (highest first):
        {
            'model': original model dict from candidates,
            'filename': model filename,
            'similarity': similarity score (0.0 to 1.0),
            'confidence': confidence percentage (0 to 100)
        }
    """
    matches = []

    # Normalize path separators in target_model based on current OS
    # This ensures paths with \ vs / separators are treated as identical
    target_model_normalized = os.path.normpath(target_model) if target_model else ""

    # Extract just the filename from target_model (remove any subfolder paths)
    # target_model might be just a filename or might include subfolder paths
    target_filename = os.path.basename(target_model_normalized)

    # Normalize target filename once for exact match comparisons
    target_norm = normalize_filename(target_filename)

    for candidate in candidate_models:
        # Get filename from candidate (prefer 'filename' key, fallback to extracting from 'path' or 'relative_path')
        candidate_filename = candidate.get("filename")
        candidate_path = candidate.get("path", "") or candidate.get("relative_path", "")

        # If no filename key, try to extract from path or relative_path
        if not candidate_filename:
            if candidate_path:
                candidate_filename = os.path.basename(candidate_path)

        if not candidate_filename:
            continue

        # Normalize candidate path separators based on current OS
        # This ensures paths with \ vs / separators are treated as identical
        candidate_path_normalized = (
            os.path.normpath(candidate_path) if candidate_path else ""
        )
        candidate_relative_path = candidate.get("relative_path", "")
        candidate_relative_path_normalized = (
            os.path.normpath(candidate_relative_path) if candidate_relative_path else ""
        )

        # Check if normalized paths are identical (100% match)
        # This handles cases where paths differ only by separator (e.g., path/to/model vs path\to\model)
        # Compare both absolute paths and relative paths
        path_match = False
        if candidate_path_normalized and target_model_normalized:
            if candidate_path_normalized == target_model_normalized:
                path_match = True
        elif candidate_relative_path_normalized and target_model_normalized:
            # Also check if relative path matches the target (which might be relative)
            if candidate_relative_path_normalized == target_model_normalized:
                path_match = True

        if path_match:
            # Exact path match after normalization = 100% confidence
            similarity = 1.0
            matches.append(
                {
                    "model": candidate,
                    "filename": candidate_filename,
                    "similarity": similarity,
                    "confidence": round(similarity * 100, 1),
                }
            )
            continue

        # Calculate similarity comparing just filenames (not paths)
        # This ensures we're comparing apples to apples

        # First check for exact match (after normalization) - should be 100%
        # Only exact matches should get 100% confidence
        candidate_norm = normalize_filename(candidate_filename)

        if target_norm == candidate_norm:
            # Exact match after normalization = 100% confidence
            similarity = 1.0
        else:
            # Calculate similarity using SequenceMatcher
            # This gives a ratio between 0.0 and 1.0 based on longest common subsequence
            similarity = calculate_similarity_with_normalization(
                target_filename, candidate_filename
            )

            # Also try comparing without extensions for better matching
            target_base = os.path.splitext(target_filename)[0]
            candidate_base = os.path.splitext(candidate_filename)[0]
            similarity_no_ext = calculate_similarity_with_normalization(
                target_base, candidate_base
            )

            # Use the higher of the two similarity scores
            # But ensure we never get 1.0 unless it's an exact normalized match
            similarity = max(similarity, similarity_no_ext)

            # Cap similarity at 0.999 for non-exact matches to prevent false 100% scores
            # SequenceMatcher can sometimes give 1.0 for very similar but not identical strings
            # due to normalization artifacts
            if similarity >= 0.999 and target_norm != candidate_norm:
                similarity = 0.999

        # Only include if above threshold
        if similarity >= threshold:
            matches.append(
                {
                    "model": candidate,
                    "filename": candidate_filename,
                    "similarity": similarity,
                    "confidence": round(similarity * 100, 1),  # Convert to percentage
                }
            )

    # Sort by similarity (highest first)
    matches.sort(key=lambda x: x["similarity"], reverse=True)

    # Limit to max_results
    matches = matches[:max_results]

    return matches
