# ComfyUI Model Linker - Fix URN Detection Plan

## Overview
Fix plugin to detect ComfyUI-AIR URNs as missing models, resolve to expected filenames via CivitAI API, fuzzy match locals.

**Status: In Progress**

## Steps

### 1. [x] URN Parsing in workflow_analyzer.py
- Added URN_REGEX, URN_TYPE_MAP
- Updated is_model_filename() to detect URNs
- Modified get_node_model_info(): parse URN → 'urn' dict, category mapping, is_urn=True, exists=False
- Add URN regex to `is_model_filename()`
- Parse components: base, type→category, provider, model_id, version_id
- Treat URNs as always "missing" (no folder_paths check)

### 2. [x] CivitAI URN Resolver in sources/civitai.py
- Added _urn_cache, resolve_urn(model_id, version_id) → model_name, expected_filename (primary file)
- API: /models/{model_id}?modelVersionId={version_id}
- Full files list, logging, error handling
- `resolve_urn(model_id, version_id)` → API https://civitai.com/api/v1/models/{model_id}?modelVersionId={version_id}
- Extract modelVersions[0].files[primary].name as expected_filename
- Cache results

### 3. [x] Integrate URN Handling in linker.py
- Added import .sources.civitai.resolve_urn
- In analyze_and_find_matches(): resolve_urn() for is_urn=True → civitai_info, expected_filename
- Matching: use expected_filename for URNs (better fuzzy), else original_path
- In analyze_and_find_matches(): For URN refs, fetch expected_filename
- Add to missing_models: 'urn_original', 'expected_filename'

### 4. [ ] Enhance matcher.py
- Prioritize matching on expected_filename if present

### 5. [ ] Workflow Updater Support (Optional)
- Replace URN → relative_path in update_model_path()

### 6. [ ] Testing
- Create sample workflow.json with URNs
- Run plugin, verify detection/matches
- Restart ComfyUI

### 7. [ ] Polish
- UI updates (web/linker.js)
- Error handling (API fails)
- Rate limit/cache

**Next: Step 2 - Add resolver to core/sources/civitai.py**

