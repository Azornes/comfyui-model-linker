/**
 * ComfyUI Model Linker Extension - Frontend
 * 
 * Provides a menu button and dialog interface for relinking missing models in workflows.
 */

// Import ComfyUI APIs
// These paths are relative to the ComfyUI web directory
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { $el, ComfyDialog } from "../../../scripts/ui.js";

class LinkerManagerDialog extends ComfyDialog {
    constructor() {
        super();
        this.currentWorkflow = null;
        this.missingModels = [];
        this.allModels = null; // list of all available models for dropdown
        this.downloadDirectories = null;
        this.capabilities = null;
        this.downloadSubfolders = new Map();
        this.pendingResolutions = [];
        this.pendingIndex = new Map(); // key -> index in pendingResolutions
        this.activeDownloads = {};  // Track active downloads
        this.searchResultCache = new Map();
        this.cachedAnalysisData = null;
        this.cachedWorkflowSignature = null;
        this.boundHandleOutsideClick = this.handleOutsideClick.bind(this);
        this.activeTab = 'missing';  // Default tab
        this.fullscreen = false;
        this._dragging = false;
        this._dragStart = null;
        this._analysisProgressToken = null;
        
        // Inject global styles for the redesigned UI
        this.injectStyles();
        
        // Create backdrop overlay for click-outside-to-close
        this.backdrop = $el("div.model-linker-backdrop", {
            parent: document.body,
            style: {
                position: "fixed",
                top: "0",
                left: "0",
                width: "100vw",
                height: "100vh",
                backgroundColor: "rgba(0, 0, 0, 0.5)",
                zIndex: "99998",
                display: "none"
            }
        });
        
        // Create context menu for model chips
        this.contextMenu = $el("div.ml-context-menu", {
            parent: document.body,
            style: {
                position: "fixed",
                display: "none",
                zIndex: "100001"
            }
        }, [
            $el("div.ml-context-menu-item", {
                onclick: () => this.handleContextMenuAction('showInfo'),
                style: { cursor: "pointer" }
            }, [
                $el("span.ml-context-menu-item-icon", { textContent: "ℹ" }),
                $el("span", { textContent: "Show Info" })
            ]),
            $el("div.ml-context-menu-divider"),
            $el("div.ml-context-menu-item", {
                onclick: () => this.handleContextMenuAction('civitai'),
                style: { cursor: "pointer" }
            }, [
                $el("span.ml-context-menu-item-icon", { textContent: "🌐" }),
                $el("span", { textContent: "Open in CivitAI" })
            ]),
            $el("div.ml-context-menu-divider"),
            $el("div.ml-context-menu-item", {
                onclick: () => this.handleContextMenuAction('openFolder'),
                style: { cursor: "pointer" }
            }, [
                $el("span.ml-context-menu-item-icon", { textContent: "📁" }),
                $el("span", { textContent: "Open Containing Folder" })
            ])
        ]);
        
        // Selected model for context menu
        this._contextMenuModel = null;
        
        // Create dialog element using $el
        this.element = $el("div.comfy-modal", {
            id: "model-linker-modal",
            parent: document.body,
            style: {
                position: "fixed",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: "1100px",
                height: "700px",
                maxWidth: "95vw",
                maxHeight: "95vh",
                backgroundColor: "var(--comfy-menu-bg, #202020)",
                color: "var(--input-text, #ffffff)",
                border: "2px solid var(--border-color, #555555)",
                borderRadius: "8px",
                padding: "0",
                zIndex: "99999",
                boxShadow: "0 4px 20px rgba(0,0,0,0.8)",
                display: "none",
                flexDirection: "column",
                resize: "both",
                overflow: "hidden",
                minWidth: "640px",
                minHeight: "420px"
            }
        }, [
            this.createHeader(),
            this.createContent(),
            this.createFooter()
        ]);
        
        // Add click listener to backdrop
        this.backdrop.addEventListener('click', () => this.close());
        
        // Add click listener to hide context menu when clicking outside
        this.boundHandleContextMenuClick = (e) => this.handleContextMenuOutsideClick(e);
        document.addEventListener('click', this.boundHandleContextMenuClick);
    }
    
    /**
     * Build stable cache key for a missing model entry
     */
    getMissingSearchKey(missing) {
        return `${missing.node_id}:${missing.widget_index}`;
    }

    /**
     * Get or initialize search state for a missing model entry
     */
    getSearchState(missing) {
        const key = this.getMissingSearchKey(missing);
        if (!this.searchResultCache.has(key)) {
            this.searchResultCache.set(key, {
                selectedSource: 'all',
                results: {
                    popular: null,
                    model_list: null,
                    huggingface: null,
                    civitai: null
                },
                lastAttemptSources: [],
                lastAttemptFound: null
            });
        }
        return this.searchResultCache.get(key);
    }

    /**
     * Merge new search results into cached per-source results.
     * Empty responses do not delete previously found results.
     */
    mergeSearchResults(existingResults = {}, newResults = {}) {
        return {
            popular: newResults.popular || existingResults.popular || null,
            model_list: newResults.model_list || existingResults.model_list || null,
            huggingface: newResults.huggingface || existingResults.huggingface || null,
            civitai: newResults.civitai || existingResults.civitai || null,
            lora_manager_archive: newResults.lora_manager_archive || existingResults.lora_manager_archive || null
        };
    }

    getSearchIconHtml() {
        return `<span class="ml-btn-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l5 5"></path></svg></span>`;
    }

    /**
     * Return true when at least one downloadable source was found
     */
    hasSearchResults(data = {}) {
        return !!(data.popular || data.model_list || data.huggingface || data.civitai || data.lora_manager_archive);
    }

    /**
     * Convert source ids to readable labels
     */
    getSearchSourceLabel(source) {
        const labels = {
            all: 'Everything',
            local: 'Local Database',
            huggingface: 'HuggingFace',
            civitai: 'CivitAI',
            lora_manager_archive: 'LoRA Manager Archive'
        };
        return labels[source] || source;
    }

    /**
     * Update source selector buttons and helper text for one card
     */
    syncSearchSourceUi(missing, container) {
        if (!container) return;

        const state = this.getSearchState(missing);
        const selectEl = container.querySelector(`#search-source-select-${missing.node_id}-${missing.widget_index}`);
        if (selectEl) {
            selectEl.value = state.selectedSource;
        }
    }

    /**
     * Set current search source for one card
     */
    setSearchSource(missing, source, container) {
        const state = this.getSearchState(missing);
        state.selectedSource = source || 'all';
        this.syncSearchSourceUi(missing, container);
    }

    renderDownloadSourceSection(missing, downloadSource) {
        const filename = missing.original_path?.split('/').pop()?.split('\\').pop() || '';
        const isFromWorkflow = downloadSource.url_source === 'workflow';
        const isCivitaiSource = downloadSource.source === 'civitai';
        const sourceLabels = {
            popular: 'Popular Models',
            model_list: 'Model Database',
            huggingface: 'HuggingFace',
            civitai: 'CivitAI',
            workflow: 'Workflow'
        };
        const sourceLabel = isFromWorkflow ? 'Workflow' : (sourceLabels[downloadSource.source] || 'Online');
        const downloadFilename = downloadSource.filename || filename;
        const formattedDownloadName = this.formatFilename(downloadFilename, 45);
        const confidenceDisplay = typeof downloadSource.confidence === 'number'
            ? `${Math.round(downloadSource.confidence)}% match`
            : '';

        let sizeDisplay = '';
        if (downloadSource.size) {
            sizeDisplay = typeof downloadSource.size === 'number'
                ? this.formatBytes(downloadSource.size)
                : downloadSource.size;
        }

        const modelCardUrl = downloadSource.model_url || this.getModelCardUrl(downloadSource.url);

        let html = `<div class="ml-download-section">`;
        html += `<div class="ml-download-actions">`;
        html += `<button id="download-${missing.node_id}-${missing.widget_index}" class="ml-btn ml-btn-download ml-btn-sm ml-btn-download-main">`;
        html += `<span class="ml-btn-icon">☁</span> Download${sizeDisplay ? ` (${sizeDisplay})` : ''}`;
        html += `</button>`;
        if (isCivitaiSource && modelCardUrl) {
            html += `<a href="${modelCardUrl}" target="_blank" rel="noopener noreferrer" class="ml-btn ml-btn-secondary ml-btn-sm ml-btn-download-side">Open on CivitAI</a>`;
        }
        html += `</div>`;
        html += `<div class="ml-download-info">`;
        html += `<span class="ml-download-source">${isFromWorkflow ? 'URL from workflow' : sourceLabel}</span>`;
        if (confidenceDisplay) {
            html += ` <span class="ml-chip">${confidenceDisplay}</span>`;
        }
        if (modelCardUrl) {
            html += `<br><a href="${modelCardUrl}" target="_blank" rel="noopener noreferrer" class="ml-link" title="Open model card">${formattedDownloadName.display}</a>${sizeDisplay ? ` <span class="ml-download-filesize">(${sizeDisplay})</span>` : ''}`;
        } else {
            html += `<br><span title="${formattedDownloadName.full}">${formattedDownloadName.display}</span>${sizeDisplay ? ` <span class="ml-download-filesize">(${sizeDisplay})</span>` : ''}`;
        }
        html += `</div>`;
        html += this.renderDownloadTargetControls(missing, downloadSource.directory || downloadSource.category || 'checkpoints');
        html += `</div>`;
        return html;
    }

    formatSearchResultMeta(result = {}, options = {}) {
        const filename = options.filename || result.filename || '';
        const secondaryText = options.secondaryText || '';
        const confidenceValue = result.confidence;
        const confidenceDisplay = typeof confidenceValue === 'number'
            ? `${Math.round(confidenceValue)}% match`
            : '';
        const sizeDisplay = result.size
            ? (typeof result.size === 'number' ? this.formatBytes(result.size) : result.size)
            : '';

        let html = `<div style="margin-top: 4px; font-size: 12px;">`;
        if (filename) {
            html += `<span class="ml-chip">${filename}</span>`;
        }
        if (confidenceDisplay) {
            html += ` <span class="ml-chip">${confidenceDisplay}</span>`;
        }
        if (sizeDisplay) {
            html += ` <span class="ml-download-size">[${sizeDisplay}]</span>`;
        }
        if (secondaryText) {
            html += ` <span style="color: var(--ml-text-muted);">${secondaryText}</span>`;
        }
        html += `</div>`;
        return html;
    }

    renderOnlineSearchResultCard({
        statusClass,
        title,
        result,
        filename,
        secondaryText = '',
        actionHtml = '',
        topLineHtml = ''
    }) {
        let html = `<div class="ml-status ${statusClass}" style="flex-direction: column; align-items: flex-start;">`;
        html += `<strong>${title}</strong>`;
        if (topLineHtml) {
            html += topLineHtml;
        }
        html += this.formatSearchResultMeta(result, { filename, secondaryText });
        if (actionHtml) {
            html += `<div style="margin-top: 8px; display: flex; gap: 8px;">${actionHtml}</div>`;
        }
        html += `</div>`;
        return html;
    }

    buildContextMenuModelData(model = {}, fallbackName = '') {
        const resolvedPath = model.path || model.resolved_path || '';
        const filename = model.filename || fallbackName || resolvedPath.split(/[\/\\]/).pop() || '';
        return {
            ...model,
            name: model.name || filename,
            original_path: model.original_path || filename,
            resolved_path: resolvedPath,
            category: model.category || ''
        };
    }

    renderLocalMatchesContent(missing, missingIndex = 0) {
        const allMatches = missing.matches || [];
        const filteredMatches = allMatches.filter(m => m.confidence >= 70);
        const hasMatches = filteredMatches.length > 0;
        const perfectMatches = filteredMatches.filter(m => m.confidence === 100);
        const otherMatches = filteredMatches.filter(m => m.confidence < 100 && m.confidence >= 70);

        let html = '';

        if (hasMatches) {
            const matchesToShow = perfectMatches.length > 0
                ? perfectMatches
                : otherMatches.sort((a, b) => b.confidence - a.confidence).slice(0, 5);

            const sortedMatches = matchesToShow.sort((a, b) => {
                if (a.confidence === 100 && b.confidence !== 100) return -1;
                if (a.confidence !== 100 && b.confidence === 100) return 1;
                return b.confidence - a.confidence;
            });

            for (let matchIndex = 0; matchIndex < sortedMatches.length; matchIndex++) {
                const match = sortedMatches[matchIndex];
                const buttonId = `resolve-${missingIndex}-${missing.node_id}-${missing.widget_index}-${matchIndex}`;
                const matchPath = match.model?.relative_path || match.filename || '';
                const formattedPath = this.formatPath(matchPath, 45);
                const isBestMatch = matchIndex === 0 && match.confidence >= 95;
                const contextModel = this.buildContextMenuModelData(match.model || {}, match.filename || '');
                const modelData = encodeURIComponent(JSON.stringify(contextModel));

                html += `<div class="ml-match-row ${isBestMatch ? 'ml-best-match' : ''}" data-model="${modelData}" oncontextmenu="window.MLOpenContextMenu(event, this)">`;
                html += this.getConfidenceBadge(match.confidence);
                html += `<span class="ml-match-filename" title="${formattedPath.full}">${formattedPath.display}</span>`;
                html += `<button id="${buttonId}" class="ml-btn ml-btn-secondary ml-btn-sm ml-btn-utility ml-btn-link-compact">`;
                html += `<span class="ml-btn-icon">🔗</span> Link`;
                html += `</button>`;
                html += `</div>`;
            }

            if (perfectMatches.length > 0 && otherMatches.length > 0) {
                const matchId = `more-matches-${missing.node_id}-${missing.widget_index}`;
                html += `<div class="ml-no-matches ml-inline-note-action" style="cursor: pointer; color: var(--ml-accent-blue);" onclick="document.getElementById('${matchId}').style.display = document.getElementById('${matchId}').style.display === 'none' ? 'block' : 'none'; this.textContent = this.textContent === '${otherMatches.length} other matches below 100%' ? 'Hide alternatives' : '${otherMatches.length} other matches below 100%'">${otherMatches.length} other match${otherMatches.length > 1 ? 'es' : ''} below 100%</div>`;
                html += `<div id="${matchId}" style="display: none; flex-direction: column; gap: 4px; margin-top: 8px;">`;
                for (let mIdx = 0; mIdx < otherMatches.length; mIdx++) {
                    const match = otherMatches[mIdx];
                    const altBtnId = `resolve-alt-${missingIndex}-${missing.node_id}-${missing.widget_index}-${mIdx}`;
                    const contextModel = this.buildContextMenuModelData(match.model || {}, match.filename || '');
                    const modelData = encodeURIComponent(JSON.stringify(contextModel));
                    html += `<div class="ml-match-row" data-model="${modelData}" oncontextmenu="window.MLOpenContextMenu(event, this)">`;
                    html += this.getConfidenceBadge(match.confidence);
                    html += `<span class="ml-match-filename" title="${match.path || match.filename}" style="flex: 1; overflow: hidden; text-overflow: ellipsis;">${match.filename || match.path?.split(/[/\\]/).pop()}</span>`;
                    html += `<button id="${altBtnId}" class="ml-btn ml-btn-secondary ml-btn-sm ml-btn-utility ml-btn-link-compact">🔗 Link</button>`;
                    html += `</div>`;
                }
                html += `</div>`;
            }
        } else if (missing.is_urn && !missing.civitai_info) {
            html += `<div class="ml-no-matches">Waiting for CivitAI filename to search local models...</div>`;
        } else if (allMatches.length > 0 && filteredMatches.length === 0) {
            html += `<div class="ml-no-matches">No matches above 70% confidence</div>`;
        } else {
            html += `<div class="ml-no-matches">No local matches found</div>`;
        }

        return html;
    }

    wireLocalMatchButtons(container, missing, missingIndex = 0) {
        const allMatches = missing.matches || [];
        const filteredMatches = allMatches.filter(m => m.confidence >= 70);
        const perfectMatches = filteredMatches.filter(m => m.confidence === 100);
        const otherMatches = filteredMatches.filter(m => m.confidence < 100 && m.confidence >= 70);
        const matchesToShow = perfectMatches.length > 0
            ? perfectMatches
            : otherMatches.sort((a, b) => b.confidence - a.confidence).slice(0, 5);

        const sortedMatches = matchesToShow.sort((a, b) => {
            if (a.confidence === 100 && b.confidence !== 100) return -1;
            if (a.confidence !== 100 && b.confidence === 100) return 1;
            return b.confidence - a.confidence;
        });

        sortedMatches.forEach((match, matchIndex) => {
            const buttonId = `resolve-${missingIndex}-${missing.node_id}-${missing.widget_index}-${matchIndex}`;
            const resolveButton = container.querySelector(`#${buttonId}`);
            if (resolveButton) {
                resolveButton.onclick = null;
                resolveButton.addEventListener('click', () => {
                    this.queueResolution(missing, match.model);
                });
            }
        });

        if (otherMatches && otherMatches.length > 0) {
            for (let mIdx = 0; mIdx < otherMatches.length; mIdx++) {
                const match = otherMatches[mIdx];
                const altBtnId = `resolve-alt-${missingIndex}-${missing.node_id}-${missing.widget_index}-${mIdx}`;
                const altBtn = container.querySelector(`#${altBtnId}`);
                if (altBtn) {
                    altBtn.addEventListener('click', () => {
                        this.queueResolution(missing, match.model);
                    });
                }
            }
        }
    }

    async refreshUrnLocalMatches(missing) {
        if (!missing?.civitai_info?.expected_filename || !this.contentElement) return;

        const bodyId = `local-matches-body-${missing.node_id}-${missing.widget_index}`;
        const container = this.contentElement.querySelector(`#${bodyId}`);
        if (!container) return;

        container.innerHTML = `<div class="ml-no-matches">Searching local matches for "${missing.civitai_info.expected_filename}"...</div>`;

        try {
            const response = await api.fetchApi('/model_linker/local-matches', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: missing.civitai_info.expected_filename,
                    category: missing.category || ''
                })
            });

            if (!response.ok) {
                throw new Error(`Local match search failed: ${response.status}`);
            }

            const data = await response.json();
            missing.matches = Array.isArray(data.matches) ? data.matches : [];
            container.innerHTML = this.renderLocalMatchesContent(missing, missing.__displayIndex || 0);
            this.wireLocalMatchButtons(this.contentElement, missing, missing.__displayIndex || 0);
        } catch (error) {
            console.error('Model Linker: URN local match refresh error:', error);
            container.innerHTML = `<div class="ml-no-matches">Failed to refresh local matches.</div>`;
        }
    }

    /**
     * Handle click outside context menu to hide it
     */
    handleContextMenuOutsideClick(e) {
        if (!this.contextMenu) return;
        if (this.contextMenu.style.display === 'none') return;
        
        // Check if click is outside the context menu
        if (!this.contextMenu.contains(e.target)) {
            this.hideContextMenu();
        }
    }
    
    /**
     * Show context menu at the specified position
     */
    showContextMenu(x, y, model) {
        if (!this.contextMenu) return;
        
        this._contextMenuModel = model;
        
        // Position the menu
        this.contextMenu.style.left = `${x}px`;
        this.contextMenu.style.top = `${y}px`;
        this.contextMenu.style.display = 'block';
        
        // Adjust position if menu would go off screen
        const rect = this.contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.contextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.contextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
        }
    }
    
    /**
     * Hide context menu
     */
    hideContextMenu() {
        if (!this.contextMenu) return;
        this.contextMenu.style.display = 'none';
        this._contextMenuModel = null;
    }
    
    /**
     * Handle context menu item click
     */
    handleContextMenuAction(action) {
        const model = this._contextMenuModel;
        this.hideContextMenu();
        
        if (!model) return;
        
        if (action === 'civitai') {
            this.openInCivitAI(model);
        } else if (action === 'openFolder') {
            this.openContainingFolder(model);
        } else if (action === 'showInfo') {
            this.showModelInfo(model);
        }
    }

    async openContainingFolder(model) {
        const path = model?.path || model?.resolved_path || '';
        if (!path) {
            this.showNotification('No local file path available', 'error');
            return;
        }

        try {
            const response = await api.fetchApi('/model_linker/open-containing-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });

            if (!response.ok) {
                throw new Error(`Open folder failed: ${response.status}`);
            }
        } catch (error) {
            console.error('Model Linker: Open folder error:', error);
            this.showNotification('Failed to open containing folder', 'error');
        }
    }
    
    /**
     * Open model in CivitAI
     */
    async openInCivitAI(model) {
        if (!model) return;
        
        const name = model.name || model.original_path?.split(/[\/\\]/).pop() || '';
        if (!name) return;
        
        try {
            // Search CivitAI for this model using hash (pass resolved_path for hash lookup)
            const response = await api.fetchApi('/model_linker/civitai-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    filename: name, 
                    category: model.category,
                    resolved_path: model.resolved_path || ''
                })
            });
            
            if (!response.ok) {
                this.showNotification('Nie znaleziono modelu na CivitAI', 'error');
                return;
            }
            
            const data = await response.json();
            if (data.url) {
                window.open(data.url, '_blank');
            } else {
                // Try direct search on CivitAI
                const searchName = name.replace(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i, '');
                const searchUrl = `https://civitai.com/search?q=${encodeURIComponent(searchName)}`;
                window.open(searchUrl, '_blank');
            }
        } catch (e) {
            console.error('Model Linker: Error searching CivitAI:', e);
            // Fall back to direct search
            const searchName = name.replace(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i, '');
            const searchUrl = `https://civitai.com/search?q=${encodeURIComponent(searchName)}`;
            window.open(searchUrl, '_blank');
        }
    }
    
    /**
     * Show model info dialog (similar to rgthree's RgthreeLoraInfoDialog)
     */
    async showModelInfo(model) {
        if (!model) return;
        
        const name = model.name || model.original_path?.split(/[\/\\]/).pop() || '';
        if (!name) return;
        
        // Create and show the info dialog
        this.showModelInfoDialog(name, model);
    }
    
    /**
     * Show the model info dialog
     */
    showModelInfoDialog(loraName, modelData) {
        // Create info dialog element
        const dialog = this.createInfoDialog(loraName, modelData);
        this.restoreInfoDialogSize(dialog);
        
        // Show the dialog
        document.body.appendChild(dialog);
        this.bindInfoDialogResizePersistence(dialog);
        
        // Add close handlers
        const closeBtn = dialog.querySelector('.ml-info-dialog-close');
        const footerCloseBtn = dialog.querySelector('.ml-info-dialog-close-btn');
        const backdrop = dialog.querySelector('.ml-info-dialog-backdrop');
        
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeInfoDialog(dialog));
        }
        if (footerCloseBtn) {
            footerCloseBtn.addEventListener('click', () => this.closeInfoDialog(dialog));
        }
        if (backdrop) {
            backdrop.addEventListener('click', (e) => {
                // Only close if clicking backdrop itself, not its children
                if (e.target === backdrop) {
                    this.closeInfoDialog(dialog);
                }
            });
        }
        
        // Fetch CivitAI info
        this.fetchModelInfoForDialog(loraName, modelData, dialog);
    }
    
    /**
     * Create the info dialog element
     */
    createInfoDialog(loraName, modelData) {
        const loraDisplayName = loraName.replace(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i, '');
        
        const dialog = document.createElement('div');
        dialog.className = 'ml-info-dialog-backdrop';
        dialog._selectedTrainedWords = new Set();
        dialog.innerHTML = `
            <div class="ml-info-dialog">
                <div class="ml-info-dialog-header">
                    <h3 class="ml-info-dialog-title">${loraDisplayName}</h3>
                    <button class="ml-info-dialog-close">×</button>
                </div>
                <div class="ml-info-dialog-content">
                    <div class="ml-info-dialog-loading">Loading...</div>
                    <div class="ml-info-dialog-body" style="display: none;">
                        <div class="ml-info-area">
                            <span class="ml-info-tag ml-info-type"></span>
                            <span class="ml-info-tag ml-info-basemodel"></span>
                        </div>
                        <table class="ml-info-table">
                            <tbody>
                                <tr class="ml-info-file-row">
                                    <td><span>File <span class="ml-info-help" title="Local filename or resolved model path used by this entry.">?</span></span></td>
                                    <td><span class="ml-info-file"></span></td>
                                </tr>
                                <tr class="ml-info-hash-row">
                                    <td><span>Hash (sha256) <span class="ml-info-help" title="SHA256 hash used to identify the exact model version on CivitAI.">?</span></span></td>
                                    <td><span class="ml-info-hash"></span></td>
                                </tr>
                                <tr class="ml-info-civitai-row">
                                    <td><span>CivitAI <span class="ml-info-help" title="Direct link to the model or version page on CivitAI.">?</span></span></td>
                                    <td><span class="ml-info-civitai-link"></span></td>
                                </tr>
                                <tr class="ml-info-name-row">
                                    <td><span>Name <span class="ml-info-help" title="Display name returned from metadata or CivitAI for this model.">?</span></span></td>
                                    <td><span class="ml-info-name"></span></td>
                                </tr>
                                <tr class="ml-info-basemodel-row">
                                    <td><span>Base Model <span class="ml-info-help" title="Base model family this resource was trained or built on, for example SD1.5, SDXL or Flux.">?</span></span></td>
                                    <td><span class="ml-info-base-model"></span></td>
                                </tr>
                                <tr class="ml-info-trainedwords-row" style="display: none;">
                                    <td>
                                        <div class="ml-info-trained-words-label">
                                            Trained Words <span class="ml-info-help" title="Trigger words or phrases associated with this model. Click words to select them, then copy the selection.">?</span>
                                            <small class="ml-info-trained-words-meta">
                                                <span class="ml-info-trained-words-count">0 selected</span>
                                                <button type="button" class="ml-info-copy-trained-words" disabled>Copy</button>
                                            </small>
                                        </div>
                                    </td>
                                    <td>
                                        <div class="ml-info-trained-words-hint">Click words to select them.</div>
                                        <div class="ml-info-trained-words"></div>
                                    </td>
                                </tr>
                                <tr class="ml-info-clipskip-row" style="display: none;">
                                    <td><span>Clip Skip <span class="ml-info-help" title="Recommended clip skip value when the model author provides one.">?</span></span></td>
                                    <td><span class="ml-info-clip-skip"></span></td>
                                </tr>
                                <tr class="ml-info-description-row" style="display: none;">
                                    <td><span>Description <span class="ml-info-help" title="Formatted description from CivitAI or local metadata. Use Show more to expand long content.">?</span></span></td>
                                    <td>
                                        <div class="ml-info-description-wrap">
                                            <div class="ml-info-description"></div>
                                            <div class="ml-info-description-actions" style="display: none;">
                                                <button type="button" class="ml-info-description-toggle">Show more</button>
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <div class="ml-info-images"></div>
                    </div>
                </div>
                <div class="ml-info-dialog-footer">
                    <button class="ml-btn ml-btn-secondary ml-info-dialog-close-btn">Close</button>
                </div>
            </div>
        `;
        
        return dialog;
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    truncateText(value, maxLength = 160) {
        const text = String(value ?? '').trim();
        if (!text) return '';
        return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
    }

    sanitizeDescriptionHtml(html) {
        const raw = String(html ?? '').trim();
        if (!raw) return '';

        const parser = new DOMParser();
        const doc = parser.parseFromString(`<div>${raw}</div>`, 'text/html');
        const root = doc.body.firstElementChild;
        if (!root) return this.escapeHtml(raw);

        const allowedTags = new Set([
            'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre',
            'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'a', 'span'
        ]);
        const allowedStyles = new Set(['color']);

        const sanitizeNode = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) {
                node.remove();
                return;
            }

            const tag = node.tagName.toLowerCase();
            if (!allowedTags.has(tag)) {
                const parent = node.parentNode;
                if (!parent) {
                    node.remove();
                    return;
                }

                while (node.firstChild) {
                    parent.insertBefore(node.firstChild, node);
                }
                parent.removeChild(node);
                return;
            }

            const attrs = Array.from(node.attributes);
            for (const attr of attrs) {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on') || name === 'id' || name === 'class' || name.startsWith('data-')) {
                    node.removeAttribute(attr.name);
                    continue;
                }

                if (name === 'href' && tag === 'a') {
                    const href = node.getAttribute('href') || '';
                    if (!/^https?:\/\//i.test(href)) {
                        node.removeAttribute('href');
                    } else {
                        node.setAttribute('target', '_blank');
                        node.setAttribute('rel', 'noopener noreferrer');
                    }
                    continue;
                }

                if (name === 'style') {
                    const safeStyles = [];
                    const styleValue = node.getAttribute('style') || '';
                    for (const part of styleValue.split(';')) {
                        const [prop, value] = part.split(':').map(v => v?.trim());
                        if (!prop || !value) continue;
                        if (allowedStyles.has(prop.toLowerCase())) {
                            safeStyles.push(`${prop}: ${value}`);
                        }
                    }
                    if (safeStyles.length) {
                        node.setAttribute('style', safeStyles.join('; '));
                    } else {
                        node.removeAttribute('style');
                    }
                    continue;
                }

                if (!(tag === 'a' && (name === 'target' || name === 'rel')) ) {
                    node.removeAttribute(attr.name);
                }
            }

            Array.from(node.childNodes).forEach(child => sanitizeNode(child));
        };

        Array.from(root.childNodes).forEach(child => sanitizeNode(child));
        return root.innerHTML;
    }

    normalizeTrainedWords(words) {
        if (Array.isArray(words)) {
            return [...new Set(words.map(word => String(word || '').trim()).filter(Boolean))];
        }

        if (typeof words === 'string') {
            return [...new Set(
                words
                    .split(/[\n,|;]/)
                    .map(word => word.trim())
                    .filter(Boolean)
            )];
        }

        return [];
    }

    updateSelectedTrainedWordsSummary(dialog) {
        if (!dialog) return;

        const countEl = dialog.querySelector('.ml-info-trained-words-count');
        const copyBtn = dialog.querySelector('.ml-info-copy-trained-words');
        const selected = dialog._selectedTrainedWords instanceof Set
            ? Array.from(dialog._selectedTrainedWords)
            : [];

        if (countEl) {
            countEl.textContent = `${selected.length} selected`;
        }
        if (copyBtn) {
            copyBtn.disabled = selected.length === 0;
            copyBtn.textContent = 'Copy';
        }
    }

    bindInfoDialogInteractions(dialog) {
        if (!dialog || dialog.dataset.mlInfoBound === 'true') return;
        dialog.dataset.mlInfoBound = 'true';

        dialog.addEventListener('click', async (event) => {
            const wordBtn = event.target.closest('.ml-info-trained-word');
            if (wordBtn && dialog.contains(wordBtn)) {
                const word = wordBtn.dataset.word || '';
                if (word) {
                    if (!(dialog._selectedTrainedWords instanceof Set)) {
                        dialog._selectedTrainedWords = new Set();
                    }

                    if (dialog._selectedTrainedWords.has(word)) {
                        dialog._selectedTrainedWords.delete(word);
                        wordBtn.classList.remove('is-selected');
                        wordBtn.setAttribute('aria-pressed', 'false');
                    } else {
                        dialog._selectedTrainedWords.add(word);
                        wordBtn.classList.add('is-selected');
                        wordBtn.setAttribute('aria-pressed', 'true');
                    }

                    this.updateSelectedTrainedWordsSummary(dialog);
                }
                return;
            }

            const copyBtn = event.target.closest('.ml-info-copy-trained-words');
            if (copyBtn && dialog.contains(copyBtn)) {
                const words = dialog._selectedTrainedWords instanceof Set
                    ? Array.from(dialog._selectedTrainedWords)
                    : [];

                if (!words.length) return;

                try {
                    await navigator.clipboard.writeText(words.join(', '));
                    copyBtn.textContent = 'Copied';
                } catch (error) {
                    console.error('Model Linker: Failed to copy trained words:', error);
                    copyBtn.textContent = 'Failed';
                }

                setTimeout(() => {
                    if (copyBtn.isConnected) {
                        copyBtn.textContent = 'Copy';
                    }
                }, 1200);
                return;
            }

            const descToggleBtn = event.target.closest('.ml-info-description-toggle');
            if (descToggleBtn && dialog.contains(descToggleBtn)) {
                const descEl = dialog.querySelector('.ml-info-description');
                if (!descEl) return;

                const isExpanded = descEl.classList.toggle('is-expanded');
                descToggleBtn.textContent = isExpanded ? 'Show less' : 'Show more';
            }
        });
    }

    getInfoDialogElement(dialog) {
        return dialog?.querySelector?.('.ml-info-dialog') || null;
    }

    restoreInfoDialogSize(dialog) {
        const panel = this.getInfoDialogElement(dialog);
        if (!panel) return;

        try {
            const saved = JSON.parse(localStorage.getItem('model_linker_info_dialog_size') || 'null');
            if (!saved || typeof saved !== 'object') return;

            const width = Number(saved.w);
            const height = Number(saved.h);
            if (!Number.isFinite(width) || !Number.isFinite(height)) return;

            const maxWidth = Math.floor(window.innerWidth * 0.9);
            const maxHeight = Math.floor(window.innerHeight * 0.8);
            const clampedWidth = Math.max(420, Math.min(width, maxWidth));
            const clampedHeight = Math.max(320, Math.min(height, maxHeight));

            panel.style.width = `${clampedWidth}px`;
            panel.style.height = `${clampedHeight}px`;
        } catch (error) {
            console.warn('Model Linker: Failed to restore info dialog size:', error);
        }
    }

    saveInfoDialogSize(dialog) {
        const panel = this.getInfoDialogElement(dialog);
        if (!panel) return;

        const rect = panel.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (!width || !height) return;

        try {
            localStorage.setItem('model_linker_info_dialog_size', JSON.stringify({ w: width, h: height }));
        } catch (error) {
            console.warn('Model Linker: Failed to save info dialog size:', error);
        }
    }

    bindInfoDialogResizePersistence(dialog) {
        const panel = this.getInfoDialogElement(dialog);
        if (!panel || typeof ResizeObserver === 'undefined') return;
        if (dialog._infoDialogResizeObserver) return;

        let resizeSaveTimer = null;
        const observer = new ResizeObserver(() => {
            clearTimeout(resizeSaveTimer);
            resizeSaveTimer = setTimeout(() => this.saveInfoDialogSize(dialog), 180);
            dialog._infoDialogResizeSaveTimer = resizeSaveTimer;
        });

        observer.observe(panel);
        dialog._infoDialogResizeObserver = observer;
        dialog._infoDialogResizeSaveTimer = resizeSaveTimer;
    }
    
    /**
     * Fetch model info and update the dialog
     */
    async fetchModelInfoForDialog(loraName, modelData, dialog) {
        try {
            const response = await api.fetchApi('/model_linker/civitai-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    filename: loraName,
                    category: modelData?.category || '',
                    resolved_path: modelData?.resolved_path || ''
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                this.updateInfoDialogWithData(dialog, data);
            } else {
                this.updateInfoDialogError(dialog, 'Model not found on CivitAI');
            }
        } catch (e) {
            console.error('Model Linker: Error fetching model info:', e);
            this.updateInfoDialogError(dialog, 'Error fetching info');
        }
    }
    
    /**
     * Update the info dialog with data
     */
    updateInfoDialogWithData(dialog, data) {
        const loadingDiv = dialog.querySelector('.ml-info-dialog-loading');
        const bodyDiv = dialog.querySelector('.ml-info-dialog-body');
        this.bindInfoDialogInteractions(dialog);
        
        if (loadingDiv) loadingDiv.style.display = 'none';
        if (bodyDiv) bodyDiv.style.display = 'block';
        
        if (!data) {
            this.updateInfoDialogError(dialog, 'No data received');
            return;
        }
        
        // Update title
        const titleEl = dialog.querySelector('.ml-info-dialog-title');
        if (titleEl) {
            const modelName = data.model_name || data.modelName || 'Unknown Model';
            const versionName = data.version_name || data.versionName || '';
            titleEl.textContent = versionName ? `${modelName} - ${versionName}` : modelName;
        }
        
        // Update type tag
        const typeTag = dialog.querySelector('.ml-info-type');
        if (typeTag) {
            const modelType = data.model_type || data.modelType || '';
            typeTag.textContent = modelType.toUpperCase();
            typeTag.className = `ml-info-tag ml-info-type -type-${modelType.toLowerCase()}`;
        }
        
        // Update base model tag
        const baseModelTag = dialog.querySelector('.ml-info-basemodel');
        if (baseModelTag) {
            const baseModel = data.base_model || data.baseModel || '';
            baseModelTag.textContent = baseModel || '';
            if (baseModel) {
                baseModelTag.style.display = '';
                baseModelTag.className = `ml-info-tag ml-info-basemodel -basemodel-${baseModel.toLowerCase().replace(/\s+/g, '-')}`;
            } else {
                baseModelTag.style.display = 'none';
            }
        }
        
        // Update file
        const fileEl = dialog.querySelector('.ml-info-file');
        if (fileEl && data.filename) {
            fileEl.textContent = data.filename;
        }
        
        // Update hash
        const hashEl = dialog.querySelector('.ml-info-hash');
        if (hashEl) {
            hashEl.textContent = data.sha256 || data.hash || '';
        }
        
        // Update CivitAI link
        const civitaiLinkEl = dialog.querySelector('.ml-info-civitai-link');
        if (civitaiLinkEl) {
            if (data.url || data.version_url) {
                const url = data.version_url || data.url;
                civitaiLinkEl.innerHTML = `
                    <a href="${url}" target="_blank" class="ml-info-link">
                        <svg viewBox="0 0 178 178" class="ml-info-civitai-logo">
                            <defs>
                                <linearGradient id="bgblue" gradientUnits="userSpaceOnUse" x1="89.3" y1="-665.5" x2="89.3" y2="-841.1" gradientTransform="matrix(1 0 0 -1 0 -664)">
                                    <stop offset="0" style="stop-color:#1284F7"></stop>
                                    <stop offset="1" style="stop-color:#0A20C9"></stop>
                                </linearGradient>
                            </defs>
                            <path fill="#000" d="M13.3,45.4v87.7l76,43.9l76-43.9V45.4l-76-43.9L13.3,45.4z"></path>
                            <path style="fill:url(#bgblue);" d="M89.3,29.2l52,30v60l-52,30l-52-30v-60L89.3,29.2 M89.3,1.5l-76,43.9v87.8l76,43.9l76-43.9V45.4L89.3,1.5z"></path>
                            <path fill="#FFF" d="M104.1,97.2l-14.9,8.5l-14.9-8.5v-17l14.9-8.5l14.9,8.5h18.2V69.7l-33-19l-33,19v38.1l33,19l33-19V97.2H104.1z"></path>
                        </svg>
                        View on Civitai
                    </a>
                `;
            } else {
                const searchName = data.model_name || data.modelName || 'Unknown';
                civitaiLinkEl.innerHTML = `
                    <span class="ml-info-not-found">Model not found</span>
                    <a href="https://civitai.com/search?q=${encodeURIComponent(searchName)}" target="_blank" class="ml-info-link">
                        ${this.getSearchIconHtml()} Search on CivitAI
                    </a>
                `;
            }
        }
        
        // Update name
        const nameEl = dialog.querySelector('.ml-info-name');
        if (nameEl) {
            nameEl.textContent = data.model_name || data.modelName || '';
        }
        
        // Update base model row
        const baseModelRowEl = dialog.querySelector('.ml-info-base-model');
        if (baseModelRowEl) {
            const baseModel = data.base_model || data.baseModel || '';
            baseModelRowEl.textContent = baseModel;
            const row = baseModelRowEl.closest('tr');
            if (row && baseModel) {
                row.style.display = '';
            } else if (row) {
                row.style.display = 'none';
            }
        }
        
        // Update trained words
        const trainedWordsEl = dialog.querySelector('.ml-info-trained-words');
        if (trainedWordsEl) {
            const words = this.normalizeTrainedWords(data.trained_words || data.trainedWords || []);
            if (words.length > 0) {
                dialog._selectedTrainedWords = new Set();
                trainedWordsEl.innerHTML = `<div class="ml-info-trained-words-list">${words.map(word => `
                    <button
                        type="button"
                        class="ml-info-trained-word"
                        data-word="${this.escapeHtml(word)}"
                        title="${this.escapeHtml(word)}"
                        aria-pressed="false"
                    >
                        ${this.escapeHtml(word)}
                    </button>
                `).join('')}</div>`;
                const row = trainedWordsEl.closest('tr');
                if (row) row.style.display = '';
                this.updateSelectedTrainedWordsSummary(dialog);
            } else {
                const row = trainedWordsEl.closest('tr');
                if (row) row.style.display = 'none';
            }
        }
        
        // Update clip skip
        const clipSkipEl = dialog.querySelector('.ml-info-clip-skip');
        if (clipSkipEl) {
            const clipSkip = data.clip_skip || data.clipSkip;
            if (clipSkip && clipSkip !== 'None') {
                clipSkipEl.textContent = clipSkip;
                const row = clipSkipEl.closest('tr');
                if (row) row.style.display = '';
            } else {
                const row = clipSkipEl.closest('tr');
                if (row) row.style.display = 'none';
            }
        }
        
        // Update description
        const descEl = dialog.querySelector('.ml-info-description');
        if (descEl) {
            const desc = data.description || data.model_description || data.modelDescription || '';
            if (desc) {
                const actionsEl = dialog.querySelector('.ml-info-description-actions');
                const toggleBtn = dialog.querySelector('.ml-info-description-toggle');

                let sanitizedHtml = '';
                try {
                    sanitizedHtml = this.sanitizeDescriptionHtml(desc);
                } catch (error) {
                    console.error('Model Linker: Failed to sanitize description HTML:', error);
                }

                const fallbackText = this.escapeHtml(String(desc).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
                const finalHtml = sanitizedHtml && sanitizedHtml.trim() ? sanitizedHtml : `<p>${fallbackText}</p>`;
                const textOnly = finalHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

                descEl.innerHTML = finalHtml;
                descEl.classList.remove('is-expanded');

                const shouldCollapse = textOnly.length > 520 || finalHtml.length > 900;
                if (actionsEl) {
                    actionsEl.style.display = shouldCollapse ? '' : 'none';
                }
                if (toggleBtn) {
                    toggleBtn.textContent = 'Show more';
                }
                if (!shouldCollapse) {
                    descEl.classList.add('is-expanded');
                }

                const row = descEl.closest('tr');
                if (row) row.style.display = '';
            } else {
                const row = descEl.closest('tr');
                if (row) row.style.display = 'none';
            }
        }
        
        // Update images
        this.updateInfoDialogImages(dialog, data.images || data.modelImages || []);
    }
    
    /**
     * Update images in the info dialog
     */
    updateInfoDialogImages(dialog, images) {
        const imagesContainer = dialog.querySelector('.ml-info-images');
        if (!imagesContainer) return;
        if (!images.length) {
            imagesContainer.innerHTML = '';
            return;
        }

        const visibleImages = images.slice(0, 8).filter(img => img?.url);

        const renderImageCard = (img) => {
            const captionParts = [];
            if (img.civitaiUrl) {
                captionParts.push(`<a href="${this.escapeHtml(img.civitaiUrl)}" target="_blank" rel="noopener noreferrer" class="ml-info-image-link">civitai</a>`);
            }
            if (img.seed) captionParts.push(`<span><label>seed</label> ${this.escapeHtml(img.seed)}</span>`);
            if (img.steps) captionParts.push(`<span><label>steps</label> ${this.escapeHtml(img.steps)}</span>`);
            if (img.cfg) captionParts.push(`<span><label>cfg</label> ${this.escapeHtml(img.cfg)}</span>`);
            if (img.sampler) captionParts.push(`<span><label>sampler</label> ${this.escapeHtml(img.sampler)}</span>`);
            if (img.model) captionParts.push(`<span><label>model</label> ${this.escapeHtml(this.truncateText(img.model, 72))}</span>`);
            if (img.positive) captionParts.push(`<span><label>positive</label> ${this.escapeHtml(this.truncateText(img.positive, 180))}</span>`);
            if (img.negative) captionParts.push(`<span><label>negative</label> ${this.escapeHtml(this.truncateText(img.negative, 180))}</span>`);

            return `
                <div class="ml-info-image-item">
                    <figure>
                        <img src="${this.escapeHtml(img.url)}" alt="Example" loading="lazy" />
                        <figcaption>${captionParts.join('')}</figcaption>
                    </figure>
                </div>
            `;
        };

        let imagesHtml = '<div class="ml-info-images-header">Example Images</div><div class="ml-info-images-layout">';
        imagesHtml += visibleImages.map(renderImageCard).join('');
        imagesHtml += '</div>';
        imagesContainer.innerHTML = imagesHtml;
    }
    
    /**
     * Update the info dialog with error
     */
    updateInfoDialogError(dialog, message) {
        const civitaiLink = dialog.querySelector('.ml-info-civitai-link');
        if (civitaiLink) {
            civitaiLink.innerHTML = `<span class="ml-info-error">${message}</span>`;
        }
    }
    
    /**
     * Close the info dialog
     */
    closeInfoDialog(dialog) {
        if (dialog?._infoDialogResizeObserver) {
            dialog._infoDialogResizeObserver.disconnect();
            dialog._infoDialogResizeObserver = null;
        }
        if (dialog?._infoDialogResizeSaveTimer) {
            clearTimeout(dialog._infoDialogResizeSaveTimer);
            dialog._infoDialogResizeSaveTimer = null;
        }
        this.saveInfoDialogSize(dialog);

        if (dialog && dialog.parentNode) {
            dialog.parentNode.removeChild(dialog);
        }
    }
    
    /**
     * Inject global CSS styles for the Model Linker UI
     */
    injectStyles() {
        // Only inject once
        if (document.getElementById('model-linker-styles')) return;
        
        const styles = document.createElement('style');
        styles.id = 'model-linker-styles';
        styles.textContent = `
            #model-linker-modal button {
                font-size: 15px;
            }

            /* CSS Variables for Model Linker */
            :root {
                --ml-bg: #121212;
                --ml-bg-soft: #171717;
                --ml-surface-elevated: #232323;
                --ml-card-bg: #1a1a1a;
                --ml-card-bg-alt: #1d1d1d;
                --ml-panel-bg: #202020;
                --ml-panel-bg-strong: #262626;
                --ml-border: rgba(255, 255, 255, 0.08);
                --ml-border-strong: rgba(255, 255, 255, 0.14);
                --ml-divider: rgba(255, 255, 255, 0.08);
                --ml-text: #f3f3f3;
                --ml-text-muted: #b1b1b1;
                --ml-text-dim: #7b7b7b;
                --ml-text-soft: #dfdfdf;
                --ml-accent: #72d38a;
                --ml-accent-hover: #88de9e;
                --ml-accent-blue: #72d38a;
                --ml-warning: #e1b24d;
                --ml-confidence-high: #72d38a;
                --ml-confidence-medium: #e1b24d;
                --ml-confidence-low: #e06a6a;
                --ml-link-color: #d8d8d8;
                --ml-shadow: 0 18px 42px rgba(0,0,0,0.28);
                --ml-radius-sm: 8px;
                --ml-radius-md: 12px;
                --ml-radius-lg: 16px;
            }

            .ml-missing-summary {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
                margin-bottom: 10px;
                padding: 10px 12px;
                border-radius: var(--ml-radius-lg);
                background: linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%);
                border: 1px solid var(--ml-border-strong);
                box-shadow: var(--ml-shadow);
            }
            .ml-missing-summary-title {
                display: flex;
                align-items: baseline;
                gap: 10px;
                flex-wrap: wrap;
            }
            .ml-missing-summary-count {
                font-size: 15px;
                font-weight: 700;
                color: var(--ml-text);
                letter-spacing: -0.02em;
            }
            .ml-missing-summary-meta {
                font-size: 11px;
                color: var(--ml-text-muted);
            }
            
            /* Card Styles */
            .ml-card {
                background: var(--ml-card-bg);
                border: 1px solid transparent;
                border-radius: 0;
                padding: 10px 12px;
                margin-bottom: 4px;
                transition: transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
                box-shadow: inset 0 0 0 1px rgba(255,255,255,0.018);
                font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
            }
            .ml-card:nth-child(even) {
                background: var(--ml-card-bg-alt);
            }
            .ml-card:hover {
                transform: translateY(-1px);
                box-shadow:
                    inset 0 0 0 1px rgba(255,255,255,0.05),
                    0 10px 24px rgba(0,0,0,0.14);
            }
            
            /* Card Header */
            .ml-card-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 10px;
                margin-bottom: 6px;
            }
            .ml-card-title-wrap {
                min-width: 0;
                flex: 1;
                display: grid;
                gap: 4px;
            }
            .ml-card-title-meta {
                display: grid;
                gap: 2px;
            }
            .ml-card-title {
                font-size: 15px;
                line-height: 1.24;
                font-weight: 700;
                color: var(--ml-text);
                margin: 0;
                word-break: break-word;
                letter-spacing: -0.01em;
            }
            .ml-card-title-eyebrow {
                display: block;
                font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
                font-size: 10px;
                line-height: 1.35;
                color: var(--ml-text-dim);
                word-break: break-all;
            }
            .ml-card-title-primary {
                display: block;
                color: var(--ml-text-soft);
            }
            .ml-card-title-secondary {
                display: block;
                font-size: 12px;
                line-height: 1.4;
                color: var(--ml-text-muted);
                word-break: break-word;
            }
            .ml-card-subtitle {
                margin-top: 0;
                display: flex;
                align-items: center;
                gap: 4px;
                flex-wrap: wrap;
            }
            .ml-node-chip {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 7px;
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.06);
                border-radius: 999px;
                font-size: 10px;
                color: #c8c8c8;
                white-space: nowrap;
                flex-shrink: 0;
            }
            .ml-node-chip.is-locatable {
                cursor: pointer;
                padding-right: 9px;
                color: #f1f1f1;
                background: rgba(255,255,255,0.08);
                border-color: rgba(255,255,255,0.12);
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
            }
            .ml-node-chip.is-locatable:hover {
                background: rgba(255,255,255,0.12);
                border-color: rgba(255,255,255,0.18);
                color: #ffffff;
                transform: translateY(-1px);
            }
            .ml-node-chip-icon {
                font-size: 11px;
                line-height: 1;
                opacity: 0.95;
            }
            .ml-category-chip {
                display: inline-flex;
                padding: 2px 7px;
                background: rgba(255,255,255,0.045);
                border: 1px solid rgba(255,255,255,0.07);
                border-radius: 999px;
                font-size: 9px;
                color: #d3d3d3;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                font-weight: 700;
            }
            .ml-card-actions {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                gap: 6px;
                flex-wrap: wrap;
                flex-shrink: 0;
            }
            .ml-inline-civitai-link {
                color: var(--ml-text-soft);
                font-size: 14px;
                font-weight: 700;
                text-decoration: none;
                letter-spacing: -0.01em;
            }
            .ml-inline-civitai-link:hover {
                color: #ffffff;
                text-decoration: none;
            }
            
            /* Two-Column Layout */
            .ml-columns {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
            }
            @media (max-width: 700px) {
                .ml-missing-summary {
                    flex-direction: column;
                    align-items: flex-start;
                }
                .ml-columns {
                    grid-template-columns: 1fr;
                }
                .ml-card-header {
                    flex-direction: column;
                }
                .ml-card-actions {
                    justify-content: flex-start;
                }
            }
            .ml-column {
                min-width: 0;
                background: var(--ml-panel-bg);
                border: 1px solid transparent;
                border-radius: 0;
                padding: 10px;
                box-shadow: inset 0 0 0 1px rgba(148,163,184,0.06);
            }
            .ml-column-header {
                font-size: 10px;
                font-weight: 700;
                color: var(--ml-text-muted);
                text-transform: uppercase;
                letter-spacing: 0.1em;
                margin-bottom: 8px;
                padding-bottom: 6px;
                border-bottom: 1px solid var(--ml-divider);
            }
            .ml-muted-note,
            .ml-no-matches {
                padding: 8px 10px;
                border-radius: var(--ml-radius-sm);
                background: rgba(255,255,255,0.018);
                border: 1px solid transparent;
                color: var(--ml-text-muted);
                font-size: 11px;
            }
            .ml-inline-note-action {
                transition: color 0.15s ease, background 0.15s ease;
            }
            .ml-inline-note-action:hover {
                color: var(--ml-text);
                background: rgba(255,255,255,0.05);
            }
            
            /* Filename Chips */
            .ml-chip {
                display: inline-flex;
                align-items: center;
                padding: 5px 10px;
                background: rgba(255,255,255,0.07);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 999px;
                font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
                font-size: 12px;
                color: var(--ml-text);
                max-width: 100%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .ml-chip:hover {
                background: #444;
            }
            
            /* Confidence Badges */
            .ml-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 1px 7px;
                border-radius: 999px;
                font-size: 10px;
                font-weight: 600;
                min-width: 36px;
                text-align: center;
                border: 1px solid transparent;
            }
            .ml-badge-high {
                background: rgba(114,211,138,0.14);
                color: #a7e6b6;
                border-color: rgba(114,211,138,0.22);
            }
            .ml-badge-medium {
                background: rgba(225,178,77,0.15);
                color: #efd391;
                border-color: rgba(225,178,77,0.2);
            }
            .ml-badge-low {
                background: rgba(224,106,106,0.14);
                color: #efb1b1;
                border-color: rgba(224,106,106,0.2);
            }
            .ml-badge-neutral {
                background: rgba(255,255,255,0.06);
                color: #d4d4d4;
                border-color: rgba(255,255,255,0.1);
            }
            
            /* Match Row */
            .ml-match-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 8px;
                border-radius: var(--ml-radius-sm);
                margin-bottom: 4px;
                background: rgba(255,255,255,0.016);
                border: 1px solid transparent;
                transition: background 0.15s ease, box-shadow 0.15s ease;
            }
            .ml-match-row:hover {
                background: rgba(255,255,255,0.032);
                box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
            }
            .ml-match-row.ml-best-match {
                background: rgba(114,211,138,0.08);
                box-shadow: inset 0 0 0 1px rgba(114,211,138,0.16);
            }
            .ml-match-filename {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
                font-size: 11.5px;
                color: var(--ml-text-soft);
            }
            
            /* Buttons */
            .ml-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                min-height: 30px;
                padding: 6px 11px;
                border: 1px solid transparent;
                border-radius: 10px;
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
                white-space: nowrap;
                text-decoration: none;
                box-sizing: border-box;
            }
            .ml-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .ml-btn-primary {
                background: var(--ml-accent);
                color: white;
            }
            .ml-btn-primary:hover:not(:disabled) {
                background: var(--ml-accent-hover);
            }
            .ml-btn-secondary {
                background: rgba(255,255,255,0.03);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.1);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
            }
            .ml-btn-secondary:hover:not(:disabled) {
                background: rgba(255,255,255,0.05);
                border-color: rgba(255,255,255,0.16);
                transform: translateY(-1px);
            }
            .ml-btn-link {
                background: rgba(255,255,255,0.03);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.1);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
            }
            .ml-btn-link:hover:not(:disabled) {
                background: rgba(255,255,255,0.05);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.16);
                transform: translateY(-1px);
            }
            .ml-btn-download {
                background: var(--ml-accent);
                color: #101010;
                box-shadow: 0 8px 18px rgba(114,211,138,0.18);
            }
            .ml-btn-download:hover:not(:disabled) {
                background: var(--ml-accent-hover);
                transform: translateY(-1px);
            }
            .ml-btn-danger {
                background: #f44336;
                color: white;
            }
            .ml-btn-danger:hover:not(:disabled) {
                background: #d32f2f;
            }
            .ml-btn-sm {
                min-height: 24px;
                padding: 2px 7px;
                font-size: 9px;
                border-radius: 8px;
            }
            .ml-btn-ghost {
                background: rgba(255,255,255,0.018);
                color: var(--ml-text-muted);
                border-color: rgba(255,255,255,0.08);
                box-shadow: none;
            }
            .ml-btn-ghost:hover:not(:disabled) {
                background: rgba(255,255,255,0.04);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.14);
            }
            .ml-btn-utility {
                padding-inline: 6px;
                font-weight: 600;
                letter-spacing: 0.01em;
                color: var(--ml-text-soft);
            }
            .ml-btn-link-compact {
                min-width: 58px;
                gap: 4px;
                padding-inline: 5px;
                font-size: 8.75px;
            }
            .ml-btn-icon-only {
                width: 24px;
                min-width: 24px;
                padding: 0;
                aspect-ratio: 1;
            }
            .ml-btn-icon {
                font-size: 12px;
            }
            .ml-btn-icon svg {
                width: 13px;
                height: 13px;
                display: block;
            }
            .ml-card-actions .ml-btn,
            .ml-match-row .ml-btn,
            .ml-combo-row .ml-btn {
                min-height: 24px;
            }
            .ml-search-source-btn {
                border-radius: 999px;
                padding-inline: 11px;
                background: rgba(255,255,255,0.03);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.1);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
            }
            .ml-search-source-btn.ml-btn-primary {
                background: rgba(255,255,255,0.03);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.1);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
            }
            .ml-search-source-btn:hover:not(:disabled),
            .ml-search-source-btn.ml-btn-primary:hover:not(:disabled) {
                background: rgba(255,255,255,0.05);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.16);
            }
            
            /* Download Section */
            .ml-download-section {
                display: grid;
                gap: 8px;
                padding: 10px;
                background: var(--ml-surface-elevated);
                border-radius: 0;
                border: 1px solid transparent;
                box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
            }
            .ml-download-actions {
                display: grid;
                grid-template-columns: minmax(0, 1fr) auto;
                gap: 8px;
                align-items: center;
            }
            .ml-download-actions .ml-btn-download,
            .ml-download-actions .ml-btn-download:hover:not(:disabled),
            .ml-btn.ml-btn-download.ml-footer-btn,
            .ml-btn.ml-btn-download.ml-footer-btn:hover:not(:disabled) {
                background: rgba(255,255,255,0.03);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.1);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
            }
            .ml-download-actions .ml-btn-download:hover:not(:disabled),
            .ml-btn.ml-btn-download.ml-footer-btn:hover:not(:disabled) {
                background: rgba(255,255,255,0.05);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.16);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
                transform: translateY(-1px);
            }
            .ml-btn-download-main {
                justify-content: flex-start;
                padding-inline: 10px;
                font-size: 8.9px;
            }
            .ml-btn-download-side {
                min-width: 132px;
                font-size: 8.6px;
            }
            .ml-status-inline {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
            }
            .ml-download-info {
                font-size: 11px;
                color: var(--ml-text-muted);
                margin-top: 0;
                line-height: 1.55;
            }
            .ml-download-source {
                color: var(--ml-accent);
                font-weight: 700;
            }
            .ml-download-size {
                color: var(--ml-text-dim);
                margin-left: 8px;
            }
            .ml-search-source-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 8px;
            }
            .ml-search-source-picker {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
                margin-left: auto;
            }
            .ml-search-source-picker-label {
                color: var(--ml-text-muted);
                font-size: 11px;
                white-space: nowrap;
            }
            .ml-search-source-select {
                min-height: 30px;
                padding: 5px 10px;
                background: rgba(255,255,255,0.03);
                color: var(--ml-text);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 10px;
                font-size: 11px;
                outline: none;
            }
            .ml-search-source-select:focus {
                border-color: rgba(255,255,255,0.16);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
            }
            .ml-search-results {
                margin-top: 8px;
                display: none;
            }
            .ml-combo-section {
                position: relative;
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px solid var(--ml-divider);
            }
            .ml-combo-row {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 4px;
            }
            .ml-combo-label {
                opacity: 0.9;
                font-size: 10px;
                color: var(--ml-text-muted);
                font-weight: 600;
                min-width: 42px;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }
            .ml-combo-input {
                flex: 1;
                min-width: 0;
                min-height: 30px;
                padding: 5px 10px;
                background: rgba(12,16,22,0.5);
                color: var(--ml-text);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 10px;
                font-size: 12px;
                outline: none;
            }
            .ml-combo-input:focus {
                border-color: rgba(114,211,138,0.4);
                box-shadow: 0 0 0 2px rgba(114,211,138,0.12);
            }
            .ml-combo-list {
                position: absolute;
                top: calc(100% + 4px);
                left: 44px;
                right: 0;
                width: auto;
                max-height: 220px;
                overflow: auto;
                display: none;
                z-index: 100000;
                background: #22272e;
                border: 1px solid var(--ml-border-strong);
                border-radius: 10px;
                box-shadow: var(--ml-shadow);
            }
            .ml-combo-option {
                padding: 6px 8px;
                cursor: pointer;
                border-bottom: 1px solid rgba(255,255,255,0.04);
                font-size: 12px;
            }
            .ml-combo-option:last-child {
                border-bottom: none;
            }
            .ml-combo-option:hover,
            .ml-combo-option.is-highlighted {
                background: rgba(78,161,255,0.16);
            }
            .ml-combo-option-row {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .ml-combo-option code {
                flex: 1 1 0%;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                color: var(--ml-text);
            }
            .ml-combo-folder {
                margin-top: 4px;
                font-size: 10px;
                color: var(--ml-text-dim);
                opacity: 0.9;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            
            /* Status Messages */
            .ml-status {
                display: flex;
                align-items: flex-start;
                gap: 10px;
                padding: 10px 14px;
                border-radius: 10px;
                font-size: 13px;
                margin-top: 8px;
                border: 1px solid rgba(255,255,255,0.06);
            }
            .ml-status-icon {
                font-size: 16px;
                flex-shrink: 0;
            }
            .ml-status-error {
                background: rgba(244, 67, 54, 0.1);
                border: 1px solid rgba(244, 67, 54, 0.3);
                color: #ef9a9a;
            }
            .ml-status-success {
                background: rgba(76, 175, 80, 0.1);
                border: 1px solid rgba(76, 175, 80, 0.3);
                color: #a5d6a7;
            }
            .ml-status-info {
                background: rgba(33, 150, 243, 0.1);
                border: 1px solid rgba(33, 150, 243, 0.3);
                color: #90caf9;
            }
            .ml-status-warning {
                background: rgba(255, 152, 0, 0.1);
                border: 1px solid rgba(255, 152, 0, 0.3);
                color: #ffcc80;
            }
            
            /* Progress Bar */
            .ml-progress-container {
                margin-top: 8px;
            }
            .ml-progress-bar {
                height: 6px;
                background: #333;
                border-radius: 3px;
                overflow: hidden;
            }
            .ml-progress-fill {
                height: 100%;
                background: var(--ml-accent);
                transition: width 0.3s ease;
            }
            .ml-progress-text {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 6px;
                font-size: 11px;
                color: var(--ml-text-muted);
            }
            
            /* Scrollbar */
            .ml-scrollable {
                overflow-y: auto;
            }
            .ml-scrollable::-webkit-scrollbar {
                width: 8px;
            }
            .ml-scrollable::-webkit-scrollbar-track {
                background: transparent;
            }
            .ml-scrollable::-webkit-scrollbar-thumb {
                background: #444;
                border-radius: 4px;
            }
            .ml-scrollable::-webkit-scrollbar-thumb:hover {
                background: #555;
            }
            
            /* Footer */
            .ml-footer {
                display: flex;
                justify-content: flex-end;
                align-items: center;
                gap: 10px;
                flex-wrap: wrap;
                padding: 5px 18px;
                background: linear-gradient(to top, rgba(18,18,18,0.98) 0%, rgba(18,18,18,0.92) 70%, transparent 100%);
                border-top: 1px solid var(--ml-border);
            }
            .ml-footer-btn {
                min-height: 32px;
                min-width: 144px;
                padding: 7px 13px;
                font-size: 12px;
                border-radius: 9px;
                line-height: 1;
                backdrop-filter: blur(10px);
            }
            .ml-btn.ml-footer-btn,
            .ml-btn.ml-btn-primary.ml-footer-btn,
            .ml-btn.ml-btn-download.ml-footer-btn {
                background: rgba(255,255,255,0.03);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.1);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
            }
            .ml-btn.ml-footer-btn:hover:not(:disabled),
            .ml-btn.ml-btn-primary.ml-footer-btn:hover:not(:disabled),
            .ml-btn.ml-btn-download.ml-footer-btn:hover:not(:disabled) {
                background: rgba(255,255,255,0.05);
                color: var(--ml-text);
                border-color: rgba(255,255,255,0.16);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
                transform: translateY(-1px);
            }

            /* Tabs */
            .ml-tabs {
                display: flex;
                align-items: flex-end;
                gap: 6px;
                padding: 7px 16px 0 16px;
                margin-bottom: 0;
                background:
                    linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%);
                position: relative;
                z-index: 2;
                border-bottom: 1px solid var(--ml-border);
            }
            .ml-tab {
                position: relative;
                padding: 8px 13px 9px 13px;
                background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.015) 100%);
                border: 1px solid rgba(255,255,255,0.1);
                border-bottom: none;
                border-top-left-radius: 11px;
                border-top-right-radius: 11px;
                color: var(--ml-text-muted, #888);
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
                transform: translateY(4px);
                opacity: 0.8;
                transition: transform 0.18s ease, opacity 0.18s ease, color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
            }
            .ml-tab:hover {
                color: var(--ml-text-muted, #888);
                background: linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.015) 100%);
                border-color: rgba(255,255,255,0.14);
                transform: translateY(2px);
                opacity: 0.96;
            }
            .ml-tab.ml-tab-active {
                color: var(--ml-text, #eef2f7);
                background: var(--ml-bg);
                border-color: rgba(255,255,255,0.16);
                box-shadow:
                    0 -8px 18px rgba(0,0,0,0.1),
                    0 6px 10px rgba(0,0,0,0.08),
                    inset 0 1px 0 rgba(255,255,255,0.03);
                transform: translateY(1px);
                opacity: 1;
                z-index: 3;
            }
            .ml-tab.ml-tab-active::after {
                content: "";
                position: absolute;
                left: 0;
                right: 0;
                bottom: -6px;
                height: 8px;
                background: var(--ml-bg);
                border-bottom-left-radius: 8px;
                border-bottom-right-radius: 8px;
            }

            /* Loaded Models Tab */
            .ml-loaded-models {
                padding: 0;
            }
            .ml-loaded-models-header {
                padding: 16px 20px;
                border-bottom: 1px solid var(--ml-border);
            }
            .ml-loaded-models-title {
                font-size: 15px;
                font-weight: 600;
                color: var(--ml-text);
                margin: 0 0 8px 0;
            }
            .ml-loaded-models-subtitle {
                font-size: 12px;
                color: var(--ml-text-muted);
            }
            .ml-models-list {
                padding: 12px 20px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ml-model-chip {
                display: inline-flex;
                align-items: center;
                padding: 6px 12px;
                background: #3a3a3a;
                border-radius: 6px;
                font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
                font-size: 12px;
                color: var(--ml-text);
            }
            .ml-model-chip-category {
                padding: 2px 6px;
                background: #555;
                border-radius: 4px;
                font-size: 10px;
                color: #aaa;
                margin-left: 8px;
                text-transform: uppercase;
            }
            .ml-model-chip-strength {
                padding: 2px 6px;
                background: #4CAF50;
                border-radius: 4px;
                font-size: 10px;
                color: white;
                margin-left: 8px;
            }

            .model-linker-selected {
                margin: 8px 0;
                padding: 10px 12px;
                background: rgba(78, 161, 255, 0.12);
                border: 1px solid rgba(78, 161, 255, 0.28);
                border-radius: 0;
                color: var(--ml-text);
                font-size: 12px;
            }
            
            /* Link styling */
            .ml-link {
                color: var(--ml-link-color);
                text-decoration: none;
            }
            .ml-link:hover {
                text-decoration: underline;
            }
            
            /* Context menu */
            .ml-context-menu {
                position: fixed;
                background: var(--comfy-menu-bg, #202020);
                border: 1px solid var(--border-color, #555555);
                border-radius: 6px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.5);
                z-index: 100001;
                min-width: 160px;
                overflow: hidden;
            }
            .ml-context-menu-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 12px;
                font-size: 12px;
                color: var(--input-text, #e0e0e0);
                cursor: pointer;
                transition: background 0.15s ease;
            }
            .ml-context-menu-item:hover {
                background: rgba(255,255,255,0.1);
            }
            .ml-context-menu-item-icon {
                font-size: 14px;
                width: 20px;
                text-align: center;
            }
            .ml-context-menu-divider {
                height: 1px;
                background: var(--border-color, #555555);
                margin: 4px 0;
            }
            
            /* Model Info Dialog (similar to rgthree's RgthreeLoraInfoDialog) */
            .ml-info-dialog-backdrop {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0, 0, 0, 0.6);
                z-index: 100002;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .ml-info-dialog {
                background: var(--comfy-menu-bg, #202020);
                border: 2px solid var(--border-color, #555555);
                border-radius: 8px;
                width: 500px;
                max-width: 90vw;
                max-height: 80vh;
                min-width: 420px;
                min-height: 320px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                resize: both;
            }
            .ml-info-dialog-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 16px 20px;
                border-bottom: 1px solid var(--border-color, #555555);
                background: rgba(0,0,0,0.2);
            }
            .ml-info-dialog-header h3 {
                margin: 0;
                font-size: 16px;
                color: var(--input-text, #e0e0e0);
            }
            .ml-info-dialog-close {
                background: none;
                border: none;
                font-size: 24px;
                color: var(--input-text, #e0e0e0);
                cursor: pointer;
                padding: 0;
                width: 30px;
                height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 4px;
            }
            .ml-info-dialog-close:hover {
                background: rgba(255,255,255,0.1);
            }
            .ml-info-dialog-content {
                padding: 16px 20px;
                overflow-y: auto;
                flex: 1;
            }
            .ml-info-dialog-loading {
                text-align: center;
                color: var(--ml-text-muted, #888);
                padding: 20px;
            }
            .ml-info-section {
                margin-bottom: 16px;
                padding-bottom: 16px;
                border-bottom: 1px solid var(--border-color, #555555);
            }
            .ml-info-section-header {
                font-size: 12px;
                font-weight: 600;
                color: var(--ml-text-muted, #888);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 12px;
            }
            .ml-info-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 6px 0;
            }
            .ml-info-label {
                color: var(--ml-text-muted, #888);
                font-size: 13px;
            }
            .ml-info-value {
                color: var(--input-text, #e0e0e0);
                font-size: 13px;
                font-weight: 500;
            }
            .ml-info-value.ml-info-active {
                color: #4CAF50;
            }
            .ml-info-value.ml-info-inactive {
                color: #888;
            }
            .ml-info-section-civitai {
                border-bottom: none;
                margin-bottom: 0;
                padding-bottom: 0;
            }
            .ml-info-civitai-link {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ml-info-link {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 8px 12px;
                background: #2196F3;
                color: white;
                border-radius: 6px;
                text-decoration: none;
                font-size: 13px;
            }
            .ml-info-link:hover {
                background: #1976D2;
            }
            .ml-info-loading-small {
                color: var(--ml-text-muted, #888);
                font-size: 12px;
                font-style: italic;
            }
            .ml-info-not-found {
                color: #888;
                font-size: 12px;
            }
            
            /* Info Area (type/base model tags) */
            .ml-info-area {
                display: flex;
                gap: 8px;
                margin-bottom: 16px;
            }
            .ml-info-tag {
                display: inline-flex;
                align-items: center;
                padding: 4px 10px;
                background: rgba(255,255,255,0.1);
                border-radius: 4px;
                font-size: 11px;
                font-weight: 600;
                color: var(--input-text, #e0e0e0);
            }
            .ml-info-tag.-type-lora { background: rgba(33,150,243,0.2); color: #64B5F6; }
            .ml-info-tag.-type-checkpoint { background: rgba(76,175,80,0.2); color: #81C784; }
            .ml-info-tag.-type-vae { background: rgba(156,39,176,0.2); color: #BA68C8; }
            .ml-info-tag.-basemodel-sd1 { background: rgba(244,67,54,0.2); color: #EF9A9A; }
            .ml-info-tag.-basemodel-sdxl { background: rgba(33,150,243,0.2); color: #64B5F6; }
            .ml-info-tag.-basemodel-sdxl-turbo { background: rgba(33,150,243,0.2); color: #64B5F6; }
            .ml-info-tag.-basemodel-flux.1 { background: rgba(255,152,0,0.2); color: #FFB74D; }
            .ml-info-tag.-basemodel-flux.1-d { background: rgba(255,152,0,0.2); color: #FFB74D; }
            
            /* Info Table */
            .ml-info-table {
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 16px;
            }
            .ml-info-table tr {
                border-bottom: 1px solid rgba(255,255,255,0.05);
            }
            .ml-info-table tr:last-child {
                border-bottom: none;
            }
            .ml-info-table td {
                padding: 8px 4px;
                font-size: 13px;
                vertical-align: top;
            }
            .ml-info-table td:first-child {
                color: var(--ml-text-muted, #888);
                white-space: nowrap;
                width: 140px;
            }
            .ml-info-table td:last-child {
                color: var(--input-text, #e0e0e0);
                word-break: break-word;
            }
            .ml-info-trained-words-label {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 6px;
            }
            .ml-info-trained-words-meta {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                font-size: 11px;
                color: var(--ml-text-muted, #888);
            }
            .ml-info-trained-words-hint {
                margin-bottom: 8px;
                font-size: 11px;
                color: var(--ml-text-muted, #888);
            }
            .ml-info-copy-trained-words {
                border: 1px solid rgba(255,255,255,0.12);
                background: rgba(255,255,255,0.05);
                color: var(--ml-link-color, #8fc2ff);
                border-radius: 999px;
                padding: 2px 10px;
                font-size: 11px;
                cursor: pointer;
                transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
            }
            .ml-info-copy-trained-words:hover:not(:disabled) {
                background: rgba(78,161,255,0.14);
                border-color: rgba(78,161,255,0.28);
                color: #d6eaff;
            }
            .ml-info-copy-trained-words:disabled {
                opacity: 0.45;
                cursor: default;
            }
            .ml-info-trained-words-list {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                align-items: flex-start;
            }
            .ml-info-trained-word {
                border: 1px solid rgba(255,255,255,0.1);
                background: rgba(255,255,255,0.04);
                color: var(--ml-text);
                border-radius: 999px;
                padding: 6px 10px;
                font-size: 12px;
                line-height: 1.2;
                cursor: pointer;
                transition: transform 0.14s ease, background 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
            }
            .ml-info-trained-word:hover {
                transform: translateY(-1px);
                background: rgba(255,255,255,0.07);
                border-color: rgba(255,255,255,0.18);
            }
            .ml-info-trained-word.is-selected {
                background: rgba(78,161,255,0.18);
                border-color: rgba(78,161,255,0.4);
                color: #d8ebff;
                box-shadow: 0 0 0 1px rgba(78,161,255,0.15) inset;
            }
            .ml-info-description-wrap {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ml-info-description {
                line-height: 1.55;
                color: var(--input-text, #e0e0e0);
                max-height: 220px;
                overflow: hidden;
                position: relative;
            }
            .ml-info-description:not(.is-expanded)::after {
                content: "";
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                height: 56px;
                background: linear-gradient(180deg, rgba(32,32,32,0) 0%, rgba(32,32,32,0.92) 100%);
                pointer-events: none;
            }
            .ml-info-description.is-expanded {
                max-height: none;
                overflow: visible;
            }
            .ml-info-description p,
            .ml-info-description ul,
            .ml-info-description ol,
            .ml-info-description blockquote,
            .ml-info-description pre {
                margin: 0 0 10px 0;
            }
            .ml-info-description h1,
            .ml-info-description h2,
            .ml-info-description h3,
            .ml-info-description h4,
            .ml-info-description h5,
            .ml-info-description h6 {
                margin: 14px 0 8px 0;
                color: var(--ml-text);
                line-height: 1.3;
            }
            .ml-info-description ul,
            .ml-info-description ol {
                padding-left: 18px;
            }
            .ml-info-description code,
            .ml-info-description pre {
                background: rgba(255,255,255,0.05);
                border-radius: 6px;
            }
            .ml-info-description code {
                padding: 1px 5px;
                font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
                font-size: 12px;
            }
            .ml-info-description pre {
                padding: 10px 12px;
                overflow-x: auto;
                white-space: pre-wrap;
            }
            .ml-info-description a {
                color: var(--ml-link-color, #8fc2ff);
                text-decoration: none;
            }
            .ml-info-description a:hover {
                text-decoration: underline;
            }
            .ml-info-description-actions {
                display: flex;
                justify-content: flex-end;
            }
            .ml-info-description-toggle {
                border: 1px solid rgba(255,255,255,0.12);
                background: rgba(255,255,255,0.05);
                color: var(--ml-link-color, #8fc2ff);
                border-radius: 999px;
                padding: 4px 12px;
                font-size: 11px;
                cursor: pointer;
                transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
            }
            .ml-info-description-toggle:hover {
                background: rgba(78,161,255,0.14);
                border-color: rgba(78,161,255,0.28);
                color: #d6eaff;
            }
            .ml-info-help {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 14px;
                height: 14px;
                background: rgba(255,255,255,0.14);
                color: var(--ml-text-muted, #b4becb);
                border-radius: 50%;
                font-size: 10px;
                font-weight: 700;
                cursor: help;
                margin-left: 4px;
                vertical-align: middle;
                border: 1px solid rgba(255,255,255,0.12);
                user-select: none;
            }
            .ml-info-help:hover {
                background: rgba(78,161,255,0.18);
                color: #d9ecff;
                border-color: rgba(78,161,255,0.3);
            }
            
            /* Images Section */
            .ml-info-images {
                margin-top: 16px;
                padding-top: 16px;
                border-top: 1px solid var(--border-color, #555555);
            }
            .ml-info-images-header {
                font-size: 12px;
                font-weight: 600;
                color: var(--ml-text-muted, #888);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 12px;
            }
            .ml-info-images-layout {
                column-count: 3;
                column-gap: 14px;
            }
            .ml-info-image-item {
                border-radius: 6px;
                overflow: hidden;
                background: rgba(0,0,0,0.2);
                border: 1px solid rgba(255,255,255,0.06);
                break-inside: avoid;
                margin-bottom: 14px;
            }
            .ml-info-image-item figure {
                margin: 0;
                position: relative;
                display: block;
                background: rgba(0,0,0,0.3);
            }
            .ml-info-image-item img {
                width: 100%;
                height: auto;
                display: block;
                object-fit: contain;
                transition: transform 0.24s ease, filter 0.24s ease;
            }
            .ml-info-image-item figcaption {
                position: absolute;
                inset: auto 0 0 0;
                max-height: 60%;
                overflow-y: auto;
                padding: 10px;
                font-size: 11px;
                color: #e9eef5;
                background: linear-gradient(180deg, rgba(7,10,14,0) 0%, rgba(7,10,14,0.82) 16%, rgba(7,10,14,0.94) 100%);
                opacity: 0;
                transform: translateY(10px);
                transition: opacity 0.2s ease, transform 0.2s ease;
                pointer-events: none;
            }
            .ml-info-image-item figcaption span {
                display: block;
                margin-bottom: 4px;
                line-height: 1.4;
            }
            .ml-info-image-item figcaption span label {
                font-weight: 600;
                color: #b9c8d8;
                margin-right: 4px;
                text-transform: lowercase;
            }
            .ml-info-image-link {
                color: #8fc2ff;
                text-decoration: none;
                display: inline-flex;
                margin-bottom: 6px;
                pointer-events: auto;
                font-weight: 700;
            }
            .ml-info-image-item:hover img {
                transform: scale(1.01);
                filter: brightness(0.82);
            }
            .ml-info-image-item:hover figcaption,
            .ml-info-image-item:focus-within figcaption {
                opacity: 1;
                transform: translateY(0);
            }
            @media (max-width: 900px) {
                .ml-info-images-layout {
                    column-count: 2;
                }
            }
            @media (max-width: 640px) {
                .ml-info-images-layout {
                    column-count: 1;
                }
            }
            
            /* CivitAI Logo */
            .ml-info-civitai-logo {
                width: 16px;
                height: 16px;
            }
            
            /* Footer */
            .ml-info-dialog-footer {
                padding: 12px 20px;
                border-top: 1px solid var(--border-color, #555555);
                display: flex;
                justify-content: flex-end;
                gap: 8px;
            }
            .ml-info-dialog-close-btn {
                padding: 8px 16px;
            }
            .ml-info-error {
                color: #f44336;
                font-size: 12px;
            }

            .ml-options-wrap {
                max-width: 760px;
                margin: 0 auto;
                display: flex;
                flex-direction: column;
                gap: 16px;
            }
            .ml-options-card {
                background: var(--ml-card-bg);
                border: 1px solid var(--ml-border);
                border-radius: var(--ml-radius-lg);
                padding: 18px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.14);
            }
            .ml-options-title {
                margin: 0 0 6px 0;
                font-size: 16px;
                font-weight: 700;
                color: var(--ml-text);
            }
            .ml-options-subtitle {
                margin: 0 0 16px 0;
                font-size: 12px;
                color: var(--ml-text-muted);
                line-height: 1.5;
            }
            .ml-options-grid {
                display: grid;
                gap: 14px;
            }
            .ml-options-section {
                display: grid;
                gap: 14px;
                padding: 14px;
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 14px;
                background: rgba(255,255,255,0.02);
            }
            .ml-options-section-title {
                margin: 0;
                font-size: 13px;
                font-weight: 700;
                color: var(--ml-text);
            }
            .ml-options-section-subtitle {
                margin: -6px 0 0 0;
                font-size: 12px;
                color: var(--ml-text-muted);
                line-height: 1.45;
            }
            .ml-options-stack {
                display: grid;
                gap: 14px;
            }
            .ml-options-field {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .ml-options-label {
                font-size: 12px;
                font-weight: 700;
                color: var(--ml-text);
            }
            .ml-options-help {
                font-size: 12px;
                color: var(--ml-text-muted);
                line-height: 1.45;
            }
            .ml-options-input-row {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .ml-options-input {
                width: 100%;
                padding: 10px 12px;
                background: rgba(255,255,255,0.04);
                color: var(--ml-text);
                border: 1px solid var(--ml-border);
                border-radius: 10px;
                font-size: 13px;
                outline: none;
            }
            .ml-options-input:focus {
                border-color: rgba(78,161,255,0.45);
                box-shadow: 0 0 0 3px rgba(78,161,255,0.12);
            }
            .ml-options-visibility-btn {
                width: 38px;
                min-width: 38px;
                height: 38px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid var(--ml-border);
                border-radius: 10px;
                background: rgba(255,255,255,0.04);
                color: var(--ml-text-muted);
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
            }
            .ml-options-visibility-btn:hover {
                background: rgba(255,255,255,0.08);
                color: var(--ml-text);
                border-color: rgba(78,161,255,0.35);
            }
            .ml-options-visibility-btn[aria-pressed="true"] {
                color: var(--ml-text);
                border-color: rgba(78,161,255,0.35);
            }
            .ml-options-visibility-btn svg {
                width: 18px;
                height: 18px;
                display: block;
            }
            .ml-options-actions {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                margin-top: 8px;
            }
            .ml-options-status {
                margin-top: 10px;
                font-size: 12px;
                color: var(--ml-text-muted);
            }
            .ml-download-target {
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid rgba(255,255,255,0.06);
                display: grid;
                gap: 8px;
            }
            .ml-download-target-row {
                display: grid;
                gap: 6px;
            }
            .ml-download-target-label {
                font-size: 11px;
                font-weight: 700;
                color: var(--ml-text-muted);
                text-transform: uppercase;
                letter-spacing: 0.06em;
            }
            .ml-download-target-input,
            .ml-download-target-select {
                width: 100%;
                padding: 8px 10px;
                background: rgba(255,255,255,0.04);
                color: var(--ml-text);
                border: 1px solid var(--ml-border);
                border-radius: 10px;
                font-size: 12px;
                outline: none;
            }
            .ml-download-target-input:focus,
            .ml-download-target-select:focus {
                border-color: rgba(78,161,255,0.45);
                box-shadow: 0 0 0 3px rgba(78,161,255,0.12);
            }
            .ml-download-target-wrap {
                position: relative;
            }
            .ml-download-target-list {
                position: absolute;
                top: calc(100% + 4px);
                left: 0;
                right: 0;
                max-height: 220px;
                overflow: auto;
                display: none;
                z-index: 100000;
                background: #22272e;
                border: 1px solid var(--ml-border-strong);
                border-radius: 12px;
                box-shadow: var(--ml-shadow);
            }
            .ml-download-target-option {
                padding: 8px 10px;
                cursor: pointer;
                border-bottom: 1px solid rgba(255,255,255,0.04);
                color: var(--ml-text);
                font-size: 12px;
            }
            .ml-download-target-option:last-child {
                border-bottom: none;
            }
            .ml-download-target-option:hover,
            .ml-download-target-option.is-highlighted {
                background: rgba(78,161,255,0.16);
            }
        `;
        
        document.head.appendChild(styles);
    }
    
    /**
     * Get a colored confidence badge HTML
     * @param {number} confidence - Confidence percentage (0-100)
     * @returns {string} HTML for the badge
     */
    getConfidenceBadge(confidence) {
        let badgeClass;
        if (confidence >= 95) {
            badgeClass = 'ml-badge-high';
        } else if (confidence >= 70) {
            badgeClass = 'ml-badge-medium';
        } else {
            badgeClass = 'ml-badge-low';
        }
        return `<span class="ml-badge ${badgeClass}">${confidence}%</span>`;
    }

    getStatusBadge(label, variant = 'neutral') {
        return `<span class="ml-badge ml-badge-${variant}">${label}</span>`;
    }
    
    /**
     * Format a filename with smart truncation
     * @param {string} path - Full path or filename
     * @param {number} maxLength - Maximum display length
     * @returns {object} { display: truncated name, full: full name }
     */
    formatFilename(path, maxLength = 50) {
        if (!path) return { display: 'Unknown', full: 'Unknown' };
        
        // Extract just the filename from path
        const filename = path.split(/[\/\\]/).pop() || path;
        
        if (filename.length <= maxLength) {
            return { display: filename, full: filename };
        }
        
        // Smart truncation: keep extension visible
        const lastDot = filename.lastIndexOf('.');
        const ext = lastDot > 0 ? filename.slice(lastDot) : '';
        const name = lastDot > 0 ? filename.slice(0, lastDot) : filename;
        
        // Calculate how much of the name we can show
        const availableLength = maxLength - ext.length - 3; // 3 for "..."
        if (availableLength < 8) {
            // Too short, just truncate at the end
            return { display: filename.slice(0, maxLength - 3) + '...', full: filename };
        }
        
        // Truncate middle of name
        const frontLength = Math.ceil(availableLength / 2);
        const backLength = Math.floor(availableLength / 2);
        const truncated = name.slice(0, frontLength) + '...' + name.slice(-backLength) + ext;
        
        return { display: truncated, full: filename };
    }
    
    /**
     * Format a path showing directory context
     * @param {string} path - Full relative path
     * @param {number} maxLength - Maximum display length
     * @returns {object} { display: formatted path, full: full path }
     */
    formatPath(path, maxLength = 60) {
        if (!path) return { display: 'Unknown', full: 'Unknown' };
        
        if (path.length <= maxLength) {
            return { display: path, full: path };
        }
        
        // Try to show meaningful parts: first dir + filename
        const parts = path.split(/[\/\\]/);
        const filename = parts.pop() || '';
        const firstDir = parts[0] || '';
        
        if (parts.length === 0) {
            // Just a filename
            return this.formatFilename(path, maxLength);
        }
        
        // Show first directory + ... + filename
        const formatted = firstDir + '\\...' + (filename.length > 40 ? this.formatFilename(filename, 40).display : filename);
        
        if (formatted.length <= maxLength) {
            return { display: formatted, full: path };
        }
        
        // Still too long, just truncate
        return { display: path.slice(0, maxLength - 3) + '...', full: path };
    }
    
    /**
     * Render a status message with icon
     * @param {string} message - Message text
     * @param {string} type - 'error' | 'success' | 'info' | 'warning'
     * @returns {string} HTML for status message
     */
    renderStatusMessage(message, type = 'info') {
        const icons = {
            error: '⚠',
            success: '✓',
            info: 'ℹ',
            warning: '⚡'
        };
        const icon = icons[type] || icons.info;
        
        return `
            <div class="ml-status ml-status-${type}">
                <span class="ml-status-icon">${icon}</span>
                <span>${message}</span>
            </div>
        `;
    }
    
    /**
     * Render a progress bar
     * @param {number} percent - Progress percentage (0-100)
     * @param {string} leftText - Text on the left
     * @param {string} rightText - Text on the right
     * @returns {string} HTML for progress bar
     */
    renderProgressBar(percent, leftText = '', rightText = '') {
        return `
            <div class="ml-progress-container">
                <div class="ml-progress-bar">
                    <div class="ml-progress-fill" style="width: ${percent}%"></div>
                </div>
                <div class="ml-progress-text">
                    <span>${leftText}</span>
                    <span>${rightText}</span>
                </div>
            </div>
        `;
    }

    renderAnalysisProgress(progress = {}) {
        const current = Number(progress.current) || 0;
        const total = Number(progress.total) || 0;
        const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
        const message = progress.message || 'Analyzing workflow...';
        const modelName = progress.model_name ? this.escapeHtml(String(progress.model_name)) : '';
        const detail = total > 0 ? `${current} / ${total}` : 'Preparing...';

        return `
            <div class="ml-download-section">
                <div class="ml-status-inline">
                    ${this.getStatusBadge('Analyzing', 'info')}
                    <span class="ml-download-info">${message}</span>
                </div>
                ${this.renderProgressBar(percent, detail, `${percent}%`)}
                ${modelName ? `<div class="ml-download-info">${modelName}</div>` : ''}
            </div>
        `;
    }

    async pollAnalysisProgress(analysisId, token) {
        while (this._analysisProgressToken === token) {
            try {
                const response = await api.fetchApi(`/model_linker/analyze-progress/${analysisId}`);
                if (response.ok && this.contentElement && this._analysisProgressToken === token) {
                    const progress = await response.json();
                    this.contentElement.innerHTML = this.renderAnalysisProgress(progress);
                    if (progress.status === 'completed' || progress.status === 'error') {
                        return;
                    }
                }
            } catch (error) {
                console.warn('Model Linker: analysis progress polling failed', error);
            }

            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    getWorkflowSignature(workflow) {
        if (!workflow) return null;
        try {
            return JSON.stringify(workflow);
        } catch (error) {
            console.warn('Model Linker: workflow signature generation failed', error);
            return null;
        }
    }
    
    /**
     * Handle clicks outside the dialog
     */
    handleOutsideClick(e) {
        // Close if click is on the backdrop (not on the dialog itself)
        if (e.target === this.backdrop) {
            this.close();
        }
    }
    
    createHeader() {
        // Create tabs
        this.missingTab = $el("button.ml-tab.ml-tab-active", {
            textContent: "Missing Models",
            onclick: () => this.switchTab('missing')
        });
        
        this.loadedTab = $el("button.ml-tab", {
            textContent: "Loaded Models",
            onclick: () => this.switchTab('loaded')
        });

        this.optionsTab = $el("button.ml-tab", {
            textContent: "Options",
            onclick: () => this.switchTab('options')
        });
        
        return $el("div", {
            style: {
                display: "flex",
                flexDirection: "column"
            }
        }, [
            $el("div", {
                style: {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "5px 5px 5px",
                    borderBottom: "1px solid var(--border-color)",
                    backgroundColor: "var(--comfy-menu-bg, #202020)"
                }
            }, [
                $el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [
                    $el("div", {
                        id: "model-linker-drag-handle",
                        title: "Drag window",
                        ondragstart: (e) => e.preventDefault(),
                        style: {
                            cursor: "grab",
                            userSelect: "none",
                            border: "1px solid var(--border-color)",
                            borderRadius: "4px",
                            padding: "0 6px",
                            height: "24px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            opacity: "0.9"
                        }
                    }, [
                        $el("span", { textContent: "⠿" })
                    ]),
                    $el("h2", {
                        textContent: "🔗 Model Linker",
                        style: {
                            margin: "0",
                            color: "var(--input-text)",
                            fontSize: "18px",
                            fontWeight: "600"
                        }
                    })
                ]),
                $el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [
                    $el("button", {
                        id: "model-linker-fullscreen-toggle",
                        title: "Toggle full screen",
                        textContent: "⛶",
                        onclick: () => this.toggleFullScreen(),
                        style: {
                            background: "none",
                            border: "1px solid var(--border-color)",
                            fontSize: "16px",
                            cursor: "pointer",
                            color: "var(--input-text)",
                            padding: "2px 8px",
                            minWidth: "32px",
                            height: "30px",
                            borderRadius: "4px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center"
                        }
                    }),
                    $el("button", {
                        textContent: "×",
                        onclick: () => this.close(),
                        style: {
                            background: "none",
                            border: "none",
                            fontSize: "24px",
                            cursor: "pointer",
                            color: "var(--input-text)",
                            padding: "0",
                            width: "30px",
                            height: "30px",
                            borderRadius: "4px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center"
                        }
                    })
                ])
            ]),
            $el("div.ml-tabs", {}, [
                this.missingTab,
                this.loadedTab,
                this.optionsTab
            ])
        ]);
    }
    
    // Toggle full screen mode for the dialog
    toggleFullScreen() {
        this.setFullScreen(!this.fullscreen);
    }

    setFullScreen(enable) {
        this.fullscreen = !!enable;
        const el = this.element;
        if (!el) return;
        const btn = document.getElementById('model-linker-fullscreen-toggle');
        if (enable) {
            // Save current size
            try {
                const rect = el.getBoundingClientRect();
                localStorage.setItem('model_linker_modal_size_before_fs', JSON.stringify({ w: Math.round(rect.width), h: Math.round(rect.height) }));
            } catch (e) {}
            el.style.top = '0';
            el.style.left = '0';
            el.style.transform = 'none';
            el.style.width = '100vw';
            el.style.height = '100vh';
            el.style.maxWidth = '100vw';
            el.style.maxHeight = '100vh';
            el.style.borderRadius = '0';
            el.style.resize = 'none';
            if (btn) btn.textContent = '🗗';
            try { localStorage.setItem('model_linker_modal_fullscreen', '1'); } catch (e) {}
        } else {
            // Restore centered sizing
            el.style.maxWidth = '95vw';
            el.style.maxHeight = '95vh';
            el.style.borderRadius = '8px';
            el.style.resize = 'both';
            // Restore saved pre-FS size if available
            let wh = null;
            try { wh = JSON.parse(localStorage.getItem('model_linker_modal_size_before_fs') || 'null'); } catch (e) {}
            if (wh && wh.w && wh.h) {
                el.style.width = `${wh.w}px`;
                el.style.height = `${wh.h}px`;
            } else {
                el.style.width = '1100px';
                el.style.height = '700px';
            }
            // Restore last known position if available, else center
            try {
                const pos = JSON.parse(localStorage.getItem('model_linker_modal_pos') || 'null');
                if (pos && Number.isFinite(pos.top) && Number.isFinite(pos.left)) {
                    el.style.top = `${pos.top}px`;
                    el.style.left = `${pos.left}px`;
                    el.style.transform = 'none';
                } else {
                    el.style.top = '50%';
                    el.style.left = '50%';
                    el.style.transform = 'translate(-50%, -50%)';
                }
            } catch (e) {
                el.style.top = '50%';
                el.style.left = '50%';
                el.style.transform = 'translate(-50%, -50%)';
            }
            if (btn) btn.textContent = '⛶';
            try { localStorage.setItem('model_linker_modal_fullscreen', '0'); } catch (e) {}
        }
    }

    // Begin window drag
    startDrag(e) {
        try {
            const el = this.element;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            // Switch to absolute top/left (no transform) before dragging
            el.style.top = `${rect.top}px`;
            el.style.left = `${rect.left}px`;
            el.style.transform = 'none';
            this._dragging = true;
            this._dragStart = {
                x: e.clientX,
                y: e.clientY,
                top: rect.top,
                left: rect.left
            };
            // Prevent text selection while dragging
            this._prevUserSelect = document.body.style.userSelect;
            document.body.style.userSelect = 'none';
            // Attach listeners
            this._onMouseMove = (ev) => this.onDrag(ev);
            this._onMouseUp = () => this.endDrag();
            document.addEventListener('mousemove', this._onMouseMove);
            document.addEventListener('mouseup', this._onMouseUp, { once: true });
        } catch (err) { /* ignore */ }
    }

    onDrag(e) {
        if (!this._dragging || !this._dragStart) return;
        const el = this.element;
        if (!el) return;
        const dx = e.clientX - this._dragStart.x;
        const dy = e.clientY - this._dragStart.y;
        let top = this._dragStart.top + dy;
        let left = this._dragStart.left + dx;
        // Clamp so the drag handle always stays reachable on screen.
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = 4; // small padding
        const handle = document.getElementById('model-linker-drag-handle');
        if (handle) {
            const handleOffsetLeft = handle.offsetLeft;
            const handleOffsetTop = handle.offsetTop;
            const handleWidth = handle.offsetWidth;
            const handleHeight = handle.offsetHeight;
            const minLeft = pad - handleOffsetLeft;
            const maxLeft = vw - pad - handleOffsetLeft - handleWidth;
            const minTop = pad - handleOffsetTop;
            const maxTop = vh - pad - handleOffsetTop - handleHeight;
            left = Math.max(minLeft, Math.min(maxLeft, left));
            top = Math.max(minTop, Math.min(maxTop, top));
        } else {
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            left = Math.max(-w + pad, Math.min(vw - pad, left));
            top = Math.max(-h + pad, Math.min(vh - pad, top));
        }
        el.style.top = `${Math.round(top)}px`;
        el.style.left = `${Math.round(left)}px`;
    }

    endDrag() {
        if (!this._dragging) return;
        this._dragging = false;
        document.removeEventListener('mousemove', this._onMouseMove);
        // Persist position
        try {
            const el = this.element;
            const rect = el.getBoundingClientRect();
            localStorage.setItem('model_linker_modal_pos', JSON.stringify({ top: Math.round(rect.top), left: Math.round(rect.left) }));
        } catch (e) { /* ignore */ }
        // Restore selection
        try { document.body.style.userSelect = this._prevUserSelect || ''; } catch (e) {}
    }

    /**
     * Simple debounce helper
     */
    debounce(callback, wait = 250) {
        let t = null;
        return (...args) => {
            if (t) clearTimeout(t);
            t = setTimeout(() => {
                callback.apply(this, args);
            }, wait);
        };
    }

    /**
     * Ensure all models are loaded for the dropdown.
     */
    async ensureAllModelsLoaded() {
        if (this.allModels && this.allModels.length) return;
        try {
            const resp = await api.fetchApi('/model_linker/models');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const models = await resp.json();
            const list = Array.isArray(models) ? models : [];
            // Build labels and sort alphabetically
            this.allModels = list.map((m) => ({
                ...m,
                __label: `${m.category ? m.category + ': ' : ''}${m.relative_path || m.filename || ''}`
            })).sort((a, b) => (a.__label || '').localeCompare(b.__label || ''));
        } catch (e) {
            console.warn('Model Linker: could not load all models', e);
            this.allModels = [];
        }
    }

    async ensureDownloadDirectoriesLoaded() {
        if (this.downloadDirectories) return;
        try {
            const resp = await api.fetchApi('/model_linker/directories');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const directories = await resp.json();
            this.downloadDirectories = directories && typeof directories === 'object' ? directories : {};
        } catch (e) {
            console.warn('Model Linker: could not load download directories', e);
            this.downloadDirectories = {};
        }
    }

    async ensureCapabilitiesLoaded() {
        if (this.capabilities) return;
        try {
            const resp = await api.fetchApi('/model_linker/capabilities');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this.capabilities = data && typeof data === 'object' ? data : { sources: {} };
        } catch (e) {
            console.warn('Model Linker: could not load capabilities', e);
            this.capabilities = { sources: {} };
        }
    }

    isSourceAvailable(source) {
        if (!source || ['all', 'local', 'huggingface', 'civitai'].includes(source)) {
            return true;
        }
        return Boolean(this.capabilities?.sources?.[source]);
    }

    getDownloadCategoryOptions(defaultCategory = 'checkpoints') {
        const directories = this.downloadDirectories || {};
        const keys = Object.keys(directories);
        const preferred = defaultCategory || 'checkpoints';
        const ordered = [
            preferred,
            ...keys.filter(key => key !== preferred)
        ].filter((value, index, arr) => value && arr.indexOf(value) === index);

        return ordered.length > 0 ? ordered : [preferred];
    }

    getAvailableSubfolders(category = '') {
        return this.downloadSubfolders.get((category || '').toLowerCase()) || [];
    }

    normalizeFolderToken(value = '') {
        return String(value || '')
            .toLowerCase()
            .replace(/[\/\\]+/g, ' ')
            .replace(/[^a-z0-9]+/g, '');
    }

    getSuggestedCivitaiSubfolder(missing, category, folders = []) {
        if ((category || '').toLowerCase() !== 'loras' || !folders.length) {
            return '';
        }

        const civitaiData = {
            ...(missing?.civitai_info || {}),
            ...(missing?.civitai_search_result || {}),
            ...(missing?.download_source || {})
        };
        const baseModel = civitaiData.base_model || '';
        const tags = Array.isArray(civitaiData.tags) ? civitaiData.tags.filter(Boolean) : [];
        if (!baseModel) return '';

        const priorityTags = [
            'concept',
            'style',
            'character',
            'clothing',
            'pose',
            'object',
            'vehicle',
            'artist',
            'celebrity'
        ];
        const normalizedBase = this.normalizeFolderToken(baseModel);
        if (!normalizedBase) return '';

        const folderEntries = folders.map(folder => {
            const segments = String(folder || '').split(/[\/\\]/).filter(Boolean);
            return {
                value: folder,
                segments,
                normalizedSegments: segments.map(segment => this.normalizeFolderToken(segment))
            };
        });

        const baseMatches = folderEntries.filter(entry => entry.normalizedSegments[0] === normalizedBase);
        if (!baseMatches.length) return '';

        const exactBase = baseMatches.find(entry => entry.segments.length === 1);
        const orderedTags = [
            ...priorityTags.filter(tag => tags.some(value => this.normalizeFolderToken(value) === this.normalizeFolderToken(tag))),
            ...tags
        ].filter((value, index, arr) => value && arr.findIndex(other => this.normalizeFolderToken(other) === this.normalizeFolderToken(value)) === index);

        for (const tag of orderedTags) {
            const normalizedTag = this.normalizeFolderToken(tag);
            if (!normalizedTag) continue;
            const match = baseMatches.find(entry => entry.normalizedSegments[1] === normalizedTag);
            if (match) {
                return match.value;
            }
        }

        return exactBase?.value || '';
    }

    async applySuggestedCivitaiSubfolder(missing, categoryEl, subfolderEl) {
        if (!categoryEl || !subfolderEl || subfolderEl.value.trim()) return;

        await this.ensureDownloadSubfoldersLoaded(categoryEl.value);
        const folders = this.getAvailableSubfolders(categoryEl.value);
        const suggestion = this.getSuggestedCivitaiSubfolder(missing, categoryEl.value, folders);
        if (suggestion) {
            subfolderEl.value = suggestion;
        }
    }

    applySearchResultSuggestion(missing) {
        const categoryEl = this.contentElement?.querySelector(`#download-category-${missing.node_id}-${missing.widget_index}`);
        const subfolderEl = this.contentElement?.querySelector(`#download-subfolder-${missing.node_id}-${missing.widget_index}`);
        if (!categoryEl || !subfolderEl) return;
        this.applySuggestedCivitaiSubfolder(missing, categoryEl, subfolderEl);
    }

    async ensureDownloadSubfoldersLoaded(category = '') {
        const key = (category || '').trim().toLowerCase();
        if (!key) return [];
        if (key === 'unknown') {
            this.downloadSubfolders.set(key, []);
            return [];
        }
        if (this.downloadSubfolders.has(key)) {
            return this.downloadSubfolders.get(key) || [];
        }

        try {
            const resp = await api.fetchApi(`/model_linker/subfolders/${encodeURIComponent(key)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const subfolders = await resp.json();
            const list = Array.isArray(subfolders) ? subfolders : [];
            this.downloadSubfolders.set(key, list);
            return list;
        } catch (e) {
            console.warn(`Model Linker: could not load subfolders for ${key}`, e);
            this.downloadSubfolders.set(key, []);
            return [];
        }
    }

    renderDownloadTargetControls(missing, defaultCategory = 'checkpoints') {
        const selectId = `download-category-${missing.node_id}-${missing.widget_index}`;
        const subfolderId = `download-subfolder-${missing.node_id}-${missing.widget_index}`;
        const subfolderListId = `download-subfolder-list-${missing.node_id}-${missing.widget_index}`;
        const options = this.getDownloadCategoryOptions(defaultCategory)
            .map(category => `<option value="${category}" ${category === defaultCategory ? 'selected' : ''}>${category}</option>`)
            .join('');

        let html = `<div class="ml-download-target">`;
        html += `<div class="ml-download-target-row">`;
        html += `<label class="ml-download-target-label" for="${selectId}">Folder</label>`;
        html += `<select id="${selectId}" class="ml-download-target-select">${options}</select>`;
        html += `</div>`;
        html += `<div class="ml-download-target-row">`;
        html += `<label class="ml-download-target-label" for="${subfolderId}">Subfolder (optional)</label>`;
        html += `<div class="ml-download-target-wrap">`;
        html += `<input id="${subfolderId}" class="ml-download-target-input" type="text" placeholder="e.g. ponyxl\\styles" autocomplete="off">`;
        html += `<div id="${subfolderListId}" class="ml-download-target-list"></div>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;
        return html;
    }

    getDownloadTargetSelection(missing, fallbackCategory = 'checkpoints') {
        const categoryEl = this.contentElement?.querySelector(`#download-category-${missing.node_id}-${missing.widget_index}`);
        const subfolderEl = this.contentElement?.querySelector(`#download-subfolder-${missing.node_id}-${missing.widget_index}`);
        return {
            category: categoryEl?.value || fallbackCategory || 'checkpoints',
            subfolder: (subfolderEl?.value || '').trim()
        };
    }

    wireDownloadTargetAutocomplete(container, missing) {
        const categoryEl = container.querySelector(`#download-category-${missing.node_id}-${missing.widget_index}`);
        const subfolderEl = container.querySelector(`#download-subfolder-${missing.node_id}-${missing.widget_index}`);
        const listEl = container.querySelector(`#download-subfolder-list-${missing.node_id}-${missing.widget_index}`);
        if (!categoryEl || !subfolderEl || !listEl) return;

        const renderOptions = (targetEl, values, onSelect) => {
            if (!values.length) {
                targetEl.innerHTML = '';
                targetEl.style.display = 'none';
                return;
            }

            targetEl.innerHTML = values
                .slice(0, 50)
                .map(value => `<div class="ml-download-target-option" data-value="${encodeURIComponent(value)}">${value}</div>`)
                .join('');

            targetEl.style.display = 'block';

            targetEl.querySelectorAll('.ml-download-target-option').forEach(option => {
                option.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                    const value = decodeURIComponent(option.dataset.value || '');
                    onSelect(value);
                    targetEl.style.display = 'none';
                });
            });
        };

        const populateSubfolderOptions = async (filterText = '') => {
            const filter = (filterText || '').toLowerCase();
            await this.ensureDownloadSubfoldersLoaded(categoryEl.value);
            const folders = this.getAvailableSubfolders(categoryEl.value);
            const filtered = filter
                ? folders.filter(folder => folder.toLowerCase().includes(filter))
                : folders;

            renderOptions(listEl, filtered, (value) => {
                subfolderEl.value = value;
            });
        };

        const hideList = (targetEl) => {
            setTimeout(() => {
                targetEl.style.display = 'none';
            }, 150);
        };

        categoryEl.addEventListener('change', () => {
            populateSubfolderOptions(subfolderEl.value);
            this.applySuggestedCivitaiSubfolder(missing, categoryEl, subfolderEl);
        });

        subfolderEl.addEventListener('focus', () => {
            populateSubfolderOptions(subfolderEl.value);
        });

        subfolderEl.addEventListener('input', () => {
            populateSubfolderOptions(subfolderEl.value);
        });

        subfolderEl.addEventListener('blur', () => hideList(listEl));
        this.applySuggestedCivitaiSubfolder(missing, categoryEl, subfolderEl);
    }

    getStoredTokens() {
        const civitaiCandidateLimitRaw = parseInt(localStorage.getItem('modelLinker.civitaiCandidateLimit') || '5', 10);
        const civitai_candidate_limit = Number.isFinite(civitaiCandidateLimitRaw)
            ? Math.min(20, Math.max(1, civitaiCandidateLimitRaw))
            : 5;

        return {
            civitai_key: localStorage.getItem('modelLinker.civitaiApiKey') || '',
            civitai_session_token: localStorage.getItem('modelLinker.civitaiSessionToken') || '',
            hf_token: localStorage.getItem('modelLinker.huggingFaceToken') || '',
            civitai_candidate_limit
        };
    }

    async clearSearchCaches() {
        this.searchResultCache.clear();
        try {
            const response = await api.fetchApi('/model_linker/clear-search-cache', {
                method: 'POST'
            });
            if (!response.ok) {
                throw new Error('Failed to clear backend search cache');
            }
        } catch (error) {
            console.error('Model Linker: Clear search cache error:', error);
        }
    }

    displayOptions() {
        if (!this.contentElement) return;

        const tokens = this.getStoredTokens();
        this.contentElement.innerHTML = `
            <div class="ml-options-wrap">
                <div class="ml-options-card">
                    <h3 class="ml-options-title">API Tokens</h3>
                    <p class="ml-options-subtitle">Stored locally in your browser. API keys are used for downloads. Session token can improve CivitAI web search results, including NSFW items visible to your logged-in account.</p>
                    <div class="ml-options-grid">
                        <div class="ml-options-section">
                            <h4 class="ml-options-section-title">CivitAI</h4>
                            <p class="ml-options-section-subtitle">All CivitAI-related options are grouped here for downloads and search behavior.</p>
                            <div class="ml-options-stack">
                                <div class="ml-options-field">
                                    <label for="ml-options-civitai" class="ml-options-label">CivitAI API Key</label>
                                    <div class="ml-options-input-row">
                                        <input id="ml-options-civitai" class="ml-options-input" type="password" placeholder="Paste CivitAI API key" value="${tokens.civitai_key}">
                                        <button id="ml-options-civitai-toggle" type="button" class="ml-options-visibility-btn" aria-label="Show or hide CivitAI API key" title="Show or hide">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path>
                                                <circle cx="12" cy="12" r="3"></circle>
                                            </svg>
                                        </button>
                                    </div>
                                    <div class="ml-options-help">Used for direct CivitAI downloads that otherwise return HTTP 401 or 403.</div>
                                </div>
                                <div class="ml-options-field">
                                    <label for="ml-options-civitai-session" class="ml-options-label">CivitAI Session Token <button id="ml-options-civitai-help" type="button" class="ml-options-inline-link">(How to get)</button></label>
                                    <div class="ml-options-input-row">
                                        <input id="ml-options-civitai-session" class="ml-options-input" type="password" placeholder="Paste __Secure-civitai-token" value="${tokens.civitai_session_token}">
                                        <button id="ml-options-civitai-session-toggle" type="button" class="ml-options-visibility-btn" aria-label="Show or hide CivitAI session token" title="Show or hide">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path>
                                                <circle cx="12" cy="12" r="3"></circle>
                                            </svg>
                                        </button>
                                    </div>
                                    <div class="ml-options-help">Used only for CivitAI web search (civitai.red) to include results available to your logged-in session, including NSFW. Keep it private.</div>
                                    <div id="ml-options-civitai-help-panel" class="ml-options-help-panel" style="display: none;">
                                        <h4 class="ml-options-help-title">How to get the CivitAI Session Token</h4>
                                        <ol class="ml-options-help-list">
                                            <li>Click <strong>Open CivitAI</strong> below and sign in to your CivitAI account in the browser.</li>
                                            <li>On the CivitAI page, press <strong>F12</strong> to open DevTools.</li>
                                            <li>Open the <strong>Application</strong> tab. If you do not see it, click the <strong>&raquo;</strong> overflow menu first.</li>
                                            <li>In the left sidebar, open <strong>Storage</strong> or <strong>Cookies</strong>, then select <strong>https://civitai.red</strong>.</li>
                                            <li>Find the cookie named <strong>__Secure-civitai-token</strong>.</li>
                                            <li>Copy its <strong>Value</strong> and paste it into the <strong>CivitAI Session Token</strong> field above.</li>
                                            <li>Click <strong>Save</strong>. The search cache will be cleared automatically.</li>
                                        </ol>
                                        <div class="ml-options-help-actions">
                                            <button id="ml-options-open-civitai" class="ml-btn ml-btn-primary">Open CivitAI</button>
                                        </div>
                                        <div class="ml-options-help-note">Keep this token private. It gives access to search results visible to your logged-in CivitAI account.</div>
                                    </div>
                                </div>
                                <div class="ml-options-field">
                                    <label for="ml-options-civitai-limit" class="ml-options-label">CivitAI Models To Inspect</label>
                                    <div class="ml-options-input-row">
                                        <input id="ml-options-civitai-limit" class="ml-options-input" type="number" min="1" max="20" step="1" value="${tokens.civitai_candidate_limit}">
                                    </div>
                                    <div class="ml-options-help">Checks the first N CivitAI search results in order. Stops early when an exact 100% filename match is found.</div>
                                </div>
                            </div>
                        </div>
                        <div class="ml-options-section">
                            <h4 class="ml-options-section-title">HuggingFace</h4>
                            <p class="ml-options-section-subtitle">Authorization for gated repositories and protected downloads.</p>
                            <div class="ml-options-stack">
                                <div class="ml-options-field">
                                    <label for="ml-options-hf" class="ml-options-label">HuggingFace Token</label>
                                    <div class="ml-options-input-row">
                                        <input id="ml-options-hf" class="ml-options-input" type="password" placeholder="Paste HuggingFace token" value="${tokens.hf_token}">
                                        <button id="ml-options-hf-toggle" type="button" class="ml-options-visibility-btn" aria-label="Show or hide HuggingFace token" title="Show or hide">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path>
                                                <circle cx="12" cy="12" r="3"></circle>
                                            </svg>
                                        </button>
                                    </div>
                                    <div class="ml-options-help">Used for gated HuggingFace repos that need authorization during download.</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="ml-options-actions">
                        <button id="ml-options-save" class="ml-btn ml-btn-primary ml-footer-btn">Save</button>
                    </div>
                    <div id="ml-options-status" class="ml-options-status">Saved only on this machine.</div>
                </div>
            </div>
        `;

        const civitaiInput = this.contentElement.querySelector('#ml-options-civitai');
        const civitaiSessionInput = this.contentElement.querySelector('#ml-options-civitai-session');
        const hfInput = this.contentElement.querySelector('#ml-options-hf');
        const civitaiToggle = this.contentElement.querySelector('#ml-options-civitai-toggle');
        const civitaiSessionToggle = this.contentElement.querySelector('#ml-options-civitai-session-toggle');
        const hfToggle = this.contentElement.querySelector('#ml-options-hf-toggle');
        const civitaiLimitInput = this.contentElement.querySelector('#ml-options-civitai-limit');
        const status = this.contentElement.querySelector('#ml-options-status');
        const saveBtn = this.contentElement.querySelector('#ml-options-save');
        const civitaiHelpBtn = this.contentElement.querySelector('#ml-options-civitai-help');
        const civitaiHelpPanel = this.contentElement.querySelector('#ml-options-civitai-help-panel');
        const openCivitaiBtn = this.contentElement.querySelector('#ml-options-open-civitai');

        const getVisibilityIcon = (visible) => visible
            ? `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                </svg>
            `
            : `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19C5 19 1 12 1 12a21.77 21.77 0 0 1 5.06-5.94"></path>
                    <path d="M9.9 4.24A10.93 10.93 0 0 1 12 4c7 0 11 8 11 8a21.72 21.72 0 0 1-4.31 5.18"></path>
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path>
                    <path d="M1 1l22 22"></path>
                </svg>
            `;

        const syncVisibilityToggle = (input, button) => {
            if (!input || !button) return;
            const visible = input.type === 'text';
            button.innerHTML = getVisibilityIcon(visible);
            button.style.color = visible ? 'var(--ml-text)' : 'var(--ml-text-muted)';
            button.setAttribute('aria-pressed', visible ? 'true' : 'false');
            button.setAttribute('title', visible ? 'Hide value' : 'Show value');
        };

        const bindVisibilityToggle = (input, button) => {
            if (!input || !button) return;
            syncVisibilityToggle(input, button);
            button.addEventListener('click', () => {
                input.type = input.type === 'password' ? 'text' : 'password';
                syncVisibilityToggle(input, button);
            });
        };

        bindVisibilityToggle(civitaiInput, civitaiToggle);
        bindVisibilityToggle(civitaiSessionInput, civitaiSessionToggle);
        bindVisibilityToggle(hfInput, hfToggle);

        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const civitaiCandidateLimitRaw = parseInt(civitaiLimitInput?.value || `${tokens.civitai_candidate_limit}`, 10);
                const civitaiCandidateLimit = Number.isFinite(civitaiCandidateLimitRaw)
                    ? Math.min(20, Math.max(1, civitaiCandidateLimitRaw))
                    : 5;
                localStorage.setItem('modelLinker.civitaiApiKey', civitaiInput?.value || '');
                localStorage.setItem('modelLinker.civitaiSessionToken', civitaiSessionInput?.value || '');
                localStorage.setItem('modelLinker.huggingFaceToken', hfInput?.value || '');
                localStorage.setItem('modelLinker.civitaiCandidateLimit', `${civitaiCandidateLimit}`);
                if (civitaiLimitInput) {
                    civitaiLimitInput.value = `${civitaiCandidateLimit}`;
                }
                await this.clearSearchCaches();
                if (status) status.textContent = 'Options saved locally.';
                this.showNotification('Options saved and search cache cleared', 'success');
            });
        }

        if (civitaiHelpBtn && civitaiHelpPanel) {
            civitaiHelpBtn.addEventListener('click', () => {
                const isHidden = civitaiHelpPanel.style.display === 'none';
                civitaiHelpPanel.style.display = isHidden ? 'block' : 'none';
                civitaiHelpBtn.textContent = isHidden
                    ? 'Hide CivitAI Token Instructions'
                    : 'How To Get CivitAI Session Token';
            });
        }

        if (openCivitaiBtn) {
            openCivitaiBtn.addEventListener('click', () => {
                window.open('https://civitai.red', '_blank', 'noopener,noreferrer');
            });
        }
    }

    switchTab(tab) {
        this.activeTab = tab;
        this.animateTabContentTransition();
        
        if (tab === 'missing') {
            this.missingTab.classList.add('ml-tab-active');
            this.loadedTab.classList.remove('ml-tab-active');
            this.optionsTab.classList.remove('ml-tab-active');
            this.downloadAllButton.style.display = 'inline-flex';
            this.autoResolveButton.style.display = 'inline-flex';
            this.applyPendingBtn.style.display = 'inline-flex';
            // Show queue panel
            if (this.queueElement && !this.queueCollapsed) {
                this.queueElement.style.display = '';
            }
            if (this.splitterElement) {
                this.splitterElement.style.display = '';
            }
            this.loadWorkflowData();
        } else if (tab === 'loaded') {
            this.missingTab.classList.remove('ml-tab-active');
            this.loadedTab.classList.add('ml-tab-active');
            this.optionsTab.classList.remove('ml-tab-active');
            this.downloadAllButton.style.display = 'none';
            this.autoResolveButton.style.display = 'none';
            this.applyPendingBtn.style.display = 'none';
            // Hide queue panel in loaded models tab
            if (this.queueElement) {
                this.queueElement.style.display = 'none';
            }
            if (this.splitterElement) {
                this.splitterElement.style.display = 'none';
            }
            this.loadLoadedModels();
        } else {
            this.missingTab.classList.remove('ml-tab-active');
            this.loadedTab.classList.remove('ml-tab-active');
            this.optionsTab.classList.add('ml-tab-active');
            this.downloadAllButton.style.display = 'none';
            this.autoResolveButton.style.display = 'none';
            this.applyPendingBtn.style.display = 'none';
            if (this.queueElement) {
                this.queueElement.style.display = 'none';
            }
            if (this.splitterElement) {
                this.splitterElement.style.display = 'none';
            }
            this.displayOptions();
        }
    }

    async loadLoadedModels() {
        if (!this.contentElement) return;

        this.contentElement.innerHTML = '<p>Loading loaded models...</p>';

        try {
            const workflow = this.getCurrentWorkflow();
            if (!workflow) {
                this.contentElement.innerHTML = '<p>No workflow loaded. Please load a workflow first.</p>';
                return;
            }

            const response = await api.fetchApi('/model_linker/loaded', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow })
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            this.displayLoadedModels(this.contentElement, data);

        } catch (error) {
            console.error('Model Linker: Error loading loaded models:', error);
            if (this.contentElement) {
                this.contentElement.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
            }
        }
    }

    displayLoadedModels(container, data) {
        const loadedModels = data.loaded_models || [];
        const total = data.total || 0;

        if (total === 0) {
            container.innerHTML = this.renderStatusMessage('No models found in workflow.', 'info');
            return;
        }

        const categoryDisplayNames = {
            'checkpoints': 'checkpoint',
            'loras': 'lora',
            'vae': 'vae',
            'controlnet': 'controlnet',
            'embeddings': 'embedding',
            'upscale_models': 'upscale_model',
            'diffusion_models': 'unet',
            'clip': 'clip',
            'clip_vision': 'clip_vision',
            'hypernetworks': 'hypernetwork'
        };

        const byCategory = {};
        
        for (const model of loadedModels) {
            const cat = model.category || 'unknown';
            if (!byCategory[cat]) {
                byCategory[cat] = { active: [], inactive: [] };
            }
            
            // Determine if model is active or inactive
            // For LoraLoaderV2/LoraManager: check model.active field
            // For other nodes: check model.connected field (false means not connected or bypassed)
            let isActive = true;
            if (model.is_lora_v2) {
                // For text-based lora loaders, check both active flag AND connected status
                isActive = model.active !== false && model.connected !== false;
            } else {
                // For regular nodes, check connected status
                isActive = model.connected !== false;
            }
            
            if (isActive) {
                byCategory[cat].active.push(model);
            } else {
                byCategory[cat].inactive.push(model);
            }
        }

        const activeCount = Object.values(byCategory).reduce((sum, cat) => sum + cat.active.length, 0);
        const inactiveCount = Object.values(byCategory).reduce((sum, cat) => sum + cat.inactive.length, 0);

        const buildCategoryStrings = (filter) => {
            const result = {};
            for (const [category, modelsObj] of Object.entries(byCategory)) {
                const displayCat = categoryDisplayNames[category] || category;
                const models = filter === 'active' ? modelsObj.active : filter === 'inactive' ? modelsObj.inactive : [...modelsObj.active, ...modelsObj.inactive];
                const parts = models.map(model => {
                    const fullName = model.name || model.original_path?.split(/[\/\\]/).pop() || 'Unknown';
                    let name = fullName;
                    if (fullName.match(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i)) {
                        name = fullName.replace(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i, '');
                    }
                    const strength = model.strength !== null && model.strength !== undefined 
                        ? model.strength.toFixed(2) 
                        : '1.00';
                    return `<${displayCat}:${name}:${strength}>`;
                });
                result[category] = parts.join(' ');
            }
            return Object.values(result).join(' ');
        };

        const activeString = buildCategoryStrings('active');
        const inactiveString = buildCategoryStrings('inactive');
        const allString = buildCategoryStrings('all');

        const self = this;
        
        let html = `
            <div class="ml-loaded-models-header">
                <h3 class="ml-loaded-models-title">${total} Model${total > 1 ? 's' : ''} in Workflow</h3>
                <p class="ml-loaded-models-subtitle">LoraManager / LoraLoaderV2 nodes distinguish active/inactive</p>
            </div>
            <div style="padding: 16px 20px;">
                <div style="display: flex; gap: 8px; margin-bottom: 16px;">
                    <button class="ml-btn-filter active" id="filter-all" onclick="window.MLFilterSwitch('all')">All (${activeCount + inactiveCount})</button>
                    <button class="ml-btn-filter" id="filter-active" onclick="window.MLFilterSwitch('active')">Active (${activeCount})</button>
                    <button class="ml-btn-filter" id="filter-inactive" onclick="window.MLFilterSwitch('inactive')">Inactive (${inactiveCount})</button>
                </div>
                <style>
                    .ml-btn-filter { padding: 6px 12px; font-size: 12px; background: #333; border: 1px solid #444; color: #aaa; cursor: pointer; border-radius: 4px; }
                    .ml-btn-filter:hover { background: #444; color: #fff; }
                    .ml-btn-filter.active { background: #4CAF50; border-color: #4CAF50; color: white; }
                </style>
            </div>
            <div class="ml-models-list" style="padding: 0 20px;">
        `;

        for (const [category, modelsObj] of Object.entries(byCategory)) {
            const displayName = categoryDisplayNames[category] || category;
            const hasActive = modelsObj.active.length > 0;
            const hasInactive = modelsObj.inactive.length > 0;
            
            html += `<div class="ml-model-section" data-ml-filter="all" data-ml-active="${hasActive}" data-ml-inactive="${hasInactive}" style="margin-bottom: 16px; padding: 12px; background: var(--ml-card-bg-alt, #252525); border-radius: 8px;">`;
            
            // Add category header
            html += `<div style="margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid #333;">
                <span style="color: var(--ml-text-primary); font-size: 14px; font-weight: 600;">${displayName.toUpperCase()}</span>
            </div>`;
            
            if (hasActive) {
                const activeStr = modelsObj.active.map(m => {
                    const fullName = m.name || m.original_path?.split(/[\/\\]/).pop() || 'Unknown';
                    let name = fullName.replace(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i, '');
                    const strength = m.strength !== null && m.strength !== undefined ? m.strength.toFixed(2) : '1.00';
                    return `<${displayName}:${name}:${strength}>`;
                }).join(' ');
                
                html += `<div style="margin-bottom: 10px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="color: #4CAF50; font-size: 11px; font-weight: 600;">● ACTIVE</span>
                        <button class="ml-btn ml-btn-sm" style="padding: 3px 8px; font-size: 10px;" onclick="window.MLCopy('${activeStr.replace(/'/g, "\\'")}', this)">Copy</button>
                    </div>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px;">`;
                
                for (const model of modelsObj.active) {
                    const fullName = model.name || model.original_path?.split(/[\/\\]/).pop() || 'Unknown';
                    const name = fullName.replace(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i, '');
                    const strength = model.strength !== null && model.strength !== undefined ? model.strength.toFixed(2) : null;
                    const modelData = encodeURIComponent(JSON.stringify(model));
                    html += `<span class="ml-model-chip" data-model="${modelData}" oncontextmenu="window.MLOpenContextMenu(event, this)">${name}${strength !== null ? `<span class="ml-model-chip-strength">${strength}</span>` : ''}</span>`;
                }
                html += `</div></div>`;
            }
            
            if (hasInactive) {
                const inactiveStr = modelsObj.inactive.map(m => {
                    const fullName = m.name || m.original_path?.split(/[\/\\]/).pop() || 'Unknown';
                    let name = fullName.replace(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i, '');
                    const strength = m.strength !== null && m.strength !== undefined ? m.strength.toFixed(2) : '1.00';
                    return `<${displayName}:${name}:${strength}>`;
                }).join(' ');
                
                html += `<div>
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="color: #888; font-size: 11px; font-weight: 600;">○ INACTIVE</span>
                        <button class="ml-btn ml-btn-sm" style="padding: 3px 8px; font-size: 10px; opacity: 0.6;" onclick="window.MLCopy('${inactiveStr.replace(/'/g, "\\'")}', this)">Copy</button>
                    </div>
                    <div style="display: flex; flex-wrap: wrap; gap: 8px; opacity: 0.5;">`;
                
                for (const model of modelsObj.inactive) {
                    const fullName = model.name || model.original_path?.split(/[\/\\]/).pop() || 'Unknown';
                    const name = fullName.replace(/\.(safetensors|ckpt|pt|pth|bin|pkl|sft|onnx|gguf)$/i, '');
                    const strength = model.strength !== null && model.strength !== undefined ? model.strength.toFixed(2) : null;
                    const modelData = encodeURIComponent(JSON.stringify(model));
                    html += `<span class="ml-model-chip" data-model="${modelData}" oncontextmenu="window.MLOpenContextMenu(event, this)">${name}${strength !== null ? `<span class="ml-model-chip-strength">${strength}</span>` : ''}</span>`;
                }
                html += `</div></div>`;
            }
            
            html += `</div>`;
        }

        const copySectionId = 'ml-copy-' + Date.now();
        html += `
            </div>
            <div id="${copySectionId}" style="padding: 16px 20px; border-top: 1px solid var(--ml-border);" data-ml-active="${activeString.replace(/'/g, "\\'")}" data-ml-inactive="${inactiveString.replace(/'/g, "\\'")}" data-ml-all="${allString.replace(/'/g, "\\'")}">
                <div style="font-size: 12px; color: var(--ml-text-muted); margin-bottom: 8px;" id="${copySectionId}-label">Copy all:</div>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <code style="flex: 1; padding: 8px 12px; background: #1a1a1a; border-radius: 4px; font-family: 'SF Mono', 'Consolas', monospace; font-size: 11px; color: #90caf9; overflow-x: auto; white-space: nowrap;" id="${copySectionId}-code">${allString}</code>
                    <button class="ml-btn ml-btn-secondary" onclick="window.MLCopyCode('${copySectionId}', this)">Copy</button>
                </div>
            </div>
        `;

        container.innerHTML = html;
        
        // Store data on container for filter function
        container.dataset.mlActiveString = activeString;
        container.dataset.mlInactiveString = inactiveString;
        container.dataset.mlAllString = allString;
    }
    
    createContent() {
        // Wrap the body in a two-column layout: left = items, right = queued panel
        const body = $el("div", {
            id: "model-linker-body",
            style: {
                display: "flex",
                gap: "12px",
                padding: "10px 5px 5px 5px",
                flex: "1",
                minHeight: "0",
                alignItems: "stretch",
                position: "relative",
                backgroundColor: "var(--ml-bg, #222)"
            }
        });

        this.contentElement = $el("div.ml-scrollable", {
            id: "model-linker-content",
            style: {
                overflowY: "auto",
                flex: "1",
                minHeight: "0",
                backgroundColor: "var(--ml-bg, #222)"
            }
        });

        this.queueElement = $el("div", {
            id: "model-linker-queue",
            style: {
                width: "320px",
                minWidth: "240px",
                maxWidth: "70%",
                borderLeft: "1px solid var(--border-color)",
                paddingLeft: "12px",
                display: "flex",
                flexDirection: "column"
            }
        }, [
            this.createQueuePanel()
        ]);

        // Splitter between content and queue
        this.splitterElement = $el("div", {
            id: "model-linker-splitter",
            title: "Drag to resize panels",
            style: {
                cursor: "col-resize",
                width: "6px",
                minWidth: "6px",
                background: "var(--border-color)",
                opacity: "0.4",
                borderRadius: "3px"
            },
            ondragstart: (e) => e.preventDefault()
        });

        body.appendChild(this.contentElement);
        body.appendChild(this.splitterElement);
        body.appendChild(this.queueElement);

        // Restore saved queue width and wire splitter
        try {
            const savedSplit = localStorage.getItem('model_linker_split_w');
            if (savedSplit) {
                const w = parseInt(savedSplit, 10);
                if (!isNaN(w) && w > 0) {
                    this.queueElement.style.width = `${w}px`;
                }
            }
        } catch (e) { }

        try {
            const onSplitMouseDown = (e) => this.startSplitDrag(e);
            this.splitterElement.addEventListener('mousedown', onSplitMouseDown);
            this._splitterMouseDown = onSplitMouseDown;
        } catch (e) { }
        
        // Toggle icon always visible
        try {
            this.queueToggleIcon = $el("button", {
                id: "queue-toggle-icon",
                title: "Collapse queue",
                onclick: () => this.toggleQueueCollapsed(),
                style: {
                    position: "absolute",
                    top: "50%",
                    right: "6px",
                    transform: "translateY(-50%)",
                    zIndex: "1000",
                    padding: "2px 6px",
                    border: "1px solid var(--border-color)",
                    borderRadius: "4px",
                    background: "var(--comfy-input-bg, #2f2f2f)",
                    cursor: "pointer",
                    opacity: "0.9"
                }
            }, [document.createTextNode('⮜')]);
            body.appendChild(this.queueToggleIcon);
            this.updateQueueToggleIcon();
        } catch (e) { }
        
        // Restore queue collapsed state
        try {
            const col = localStorage.getItem('model_linker_queue_collapsed');
            if (col === '1') this.setQueueCollapsed(true);
        } catch (e) { }
        
        return body;
    }
    
    createQueuePanel() {
        // Header row with title and clear button
        this.queueHeader = $el("div", {
            style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "8px"
            }
        }, [
            $el("div", { id: "queue-title", textContent: "Queued Selections (0)", style: { fontWeight: "600" } }),
            $el("div", { style: { display: "flex", gap: "6px" } }, [
                $el("button", {
                    id: "queue-toggle",
                    className: "ml-btn ml-btn-secondary ml-btn-sm",
                    textContent: "Collapse",
                    onclick: () => this.toggleQueueCollapsed(),
                    style: { padding: "4px 8px" }
                }),
                $el("button", {
                    id: "queue-clear",
                    className: "ml-btn ml-btn-secondary ml-btn-sm",
                    textContent: "Clear All",
                    onclick: () => this.clearAllQueued(),
                    style: { padding: "4px 8px" }
                })
            ])
        ]);

        // Scrollable list
        this.queueList = $el("div", {
            id: "queue-list",
            style: {
                overflowY: "auto",
                flex: "1",
                minHeight: "0",
                border: "1px solid var(--border-color)",
                borderRadius: "4px",
                padding: "8px",
                background: "var(--comfy-input-bg, #2f2f2f)"
            }
        });

        const panel = $el("div", { style: { display: "flex", flexDirection: "column", minHeight: "0", flex: "1 1 auto" } }, [this.queueHeader, this.queueList]);
        return panel;
    }

    updateQueuePanel() {
        if (!this.queueList || !this.queueHeader) return;
        const list = Array.isArray(this.pendingResolutions) ? this.pendingResolutions : [];
        // Update title count
        const title = this.queueHeader.querySelector('#queue-title');
        if (title) title.textContent = `Queued Selections (${list.length})`;
        const toggleBtn = this.queueHeader.querySelector('#queue-toggle');
        if (toggleBtn) toggleBtn.textContent = this.queueCollapsed ? 'Expand' : 'Collapse';

        if (!list.length) {
            this.queueList.innerHTML = '<div style="opacity:0.7;">No selections queued.</div>';
            return;
        }

        let html = '<div style="display:flex; flex-direction:column; gap:6px;">';
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            const label = (r.resolved_model?.relative_path || r.resolved_model?.filename || r.resolved_path || '').toString();
            const nodeLabel = r.node_label || r.node_type || (r.subgraph_id ? 'Subgraph' : 'Node');
            const orig = (r.original_path || '').toString();
            const rmId = `queue-remove-${i}`;
            html += `<div style="border:1px solid var(--border-color); border-radius:4px; padding:6px; background: rgba(255,255,255,0.02);">`;
            html += `<div style="font-weight:600;">${nodeLabel} #${r.node_id}</div>`;
            html += `<div style="font-size:12px; opacity:0.9;">Original: <code>${orig}</code></div>`;
            html += `<div style="font-size:12px;">Selected: <code>${label}</code></div>`;
            html += `<div style="margin-top:6px;"><button id="${rmId}" class="ml-btn ml-btn-secondary ml-btn-sm" style="padding:2px 8px;">Remove</button></div>`;
        }
        html += '</div>';
        this.queueList.innerHTML = html;

        // Wire remove buttons
        for (let i = 0; i < list.length; i++) {
            const rmId = `queue-remove-${i}`;
            const btn = this.queueList.querySelector(`#${rmId}`);
            if (btn) {
                btn.addEventListener('click', () => this.removeQueuedByIndex(i));
            }
        }
    }

    // Remove queued by index
    removeQueuedByIndex(i) {
        const list = Array.isArray(this.pendingResolutions) ? this.pendingResolutions : [];
        if (i < 0 || i >= list.length) return;
        const r = list[i];
        // Remove
        this.pendingResolutions.splice(i, 1);
        this.rebuildPendingIndex();
        // Update per-item selected bar
        const m = { node_id: r.node_id, widget_index: r.widget_index, subgraph_id: r.subgraph_id, is_top_level: r.is_top_level };
        this.updateSelectedBarForMissing?.(m);
        this.updateApplyPendingButton?.();
        this.updateQueuePanel();
    }

    // Clear all queued selections
    clearAllQueued() {
        this.pendingResolutions = [];
        this.pendingIndex = new Map();
        this.updateApplyPendingButton?.();
        this.updateQueuePanel();
        try {
            document.querySelectorAll('.model-linker-selected').forEach(el => { el.style.display = 'none'; el.innerHTML = ''; });
        } catch (e) { /* ignore */ }
    }

    // Update selected bar for a specific missing model slot
    updateSelectedBarForMissing(missing) {
        if (!missing) return;
        const nodeId = missing.node_id;
        const widgetIndex = missing.widget_index;
        const subgraphId = missing.subgraph_id || '';
        const isTopLevel = missing.is_top_level !== false;
        const key = `${nodeId}:${widgetIndex}:${subgraphId}:${isTopLevel ? 'T' : 'F'}`;
        
        const selectedBar = document.getElementById(`selected-bar-${nodeId}-${widgetIndex}`);
        if (!selectedBar) return;
        
        // Find selection for this slot
        let selection = null;
        let selectionIdx = -1;
        if (this.pendingIndex.has(key)) {
            const idx = this.pendingIndex.get(key);
            if (idx >= 0 && idx < this.pendingResolutions.length) {
                selection = this.pendingResolutions[idx];
                selectionIdx = idx;
            }
        }
        
        if (!selection) {
            selectedBar.style.display = 'none';
            selectedBar.innerHTML = '';
            return;
        }
        
        // Build selected bar content
        const label = selection.resolved_model?.relative_path || selection.resolved_model?.filename || selection.resolved_path || '';
        const resolveBtnId = `selected-remove-${nodeId}-${widgetIndex}`;
        
        selectedBar.innerHTML = `<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">`;
        selectedBar.innerHTML += `<span style="color: #4CAF50; font-weight: 600;">✓ Selected:</span>`;
        selectedBar.innerHTML += `<code style="flex: 1; overflow: hidden; text-overflow: ellipsis;">${label}</code>`;
        selectedBar.innerHTML += `<button id="${resolveBtnId}" class="ml-btn ml-btn-secondary ml-btn-sm" style="padding: 2px 8px;">Remove</button>`;
        selectedBar.innerHTML += `</div>`;
        selectedBar.style.display = 'block';
        
        // Wire remove button - use key-based removal
        const removeBtn = selectedBar.querySelector(`#${resolveBtnId}`);
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                this.removeQueuedByKey(key);
            });
        }
    }

    // Remove queued by key (more reliable than index)
    removeQueuedByKey(key) {
        if (!key || !this.pendingIndex.has(key)) return;
        
        // Find and remove the item with this key
        const idx = this.pendingIndex.get(key);
        if (idx >= 0 && idx < this.pendingResolutions.length) {
            const r = this.pendingResolutions[idx];
            // Update the selected bar before removing
            const m = { node_id: r.node_id, widget_index: r.widget_index, subgraph_id: r.subgraph_id, is_top_level: r.is_top_level };
            
            // Remove from array
            this.pendingResolutions.splice(idx, 1);
            this.rebuildPendingIndex();
            this.updateSelectedBarForMissing(m);
            this.updateApplyPendingButton?.();
            this.updateQueuePanel();
        }
    }

    // Rebuild pending index after modification
    rebuildPendingIndex() {
        this.pendingIndex = new Map();
        for (let i = 0; i < this.pendingResolutions.length; i++) {
            const r = this.pendingResolutions[i];
            const key = `${r.node_id}:${r.widget_index}:${r.subgraph_id || ''}:${r.is_top_level ? 'T' : 'F'}`;
            this.pendingIndex.set(key, i);
        }
    }

    // Collapse/expand queue panel
    toggleQueueCollapsed() {
        this.setQueueCollapsed(!this.queueCollapsed);
    }

    setQueueCollapsed(collapsed) {
        this.queueCollapsed = !!collapsed;
        if (!this.queueElement || !this.splitterElement) return;
        if (this.queueCollapsed) {
            this.queueElement.style.display = 'none';
            this.splitterElement.style.display = 'none';
            try { localStorage.setItem('model_linker_queue_collapsed', '1'); } catch (e) { }
        } else {
            this.queueElement.style.display = '';
            this.splitterElement.style.display = '';
            try { localStorage.setItem('model_linker_queue_collapsed', '0'); } catch (e) { }
        }
        this.updateQueuePanel();
        this.updateQueueToggleIcon();
    }

    updateQueueToggleIcon() {
        if (!this.queueToggleIcon) return;
        if (this.queueCollapsed) {
            this.queueToggleIcon.textContent = '⮞';
            this.queueToggleIcon.title = 'Expand queue';
        } else {
            this.queueToggleIcon.textContent = '⮜';
            this.queueToggleIcon.title = 'Collapse queue';
        }
    }

    // Begin split drag for resizable panels
    startSplitDrag(e) {
        try {
            if (!this.queueElement) return;
            const rect = this.queueElement.getBoundingClientRect();
            const body = document.getElementById('model-linker-body');
            const bodyRect = body ? body.getBoundingClientRect() : { width: window.innerWidth };
            this._splitDragging = true;
            this._splitStart = {
                x: e.clientX,
                startWidth: rect.width,
                containerWidth: bodyRect.width
            };
            this._prevUserSelect = document.body.style.userSelect;
            document.body.style.userSelect = 'none';
            this._onSplitMove = (ev) => this.onSplitDrag(ev);
            this._onSplitUp = () => this.endSplitDrag();
            document.addEventListener('mousemove', this._onSplitMove);
            document.addEventListener('mouseup', this._onSplitUp, { once: true });
        } catch (err) { /* ignore */ }
    }

    onSplitDrag(e) {
        if (!this._splitDragging || !this._splitStart || !this.queueElement) return;
        const dx = e.clientX - this._splitStart.x;
        let newW = this._splitStart.startWidth - dx;
        const minW = 240;
        const maxW = Math.max(minW, Math.floor(this._splitStart.containerWidth - 360));
        if (newW < minW) newW = minW;
        if (newW > maxW) newW = maxW;
        this.queueElement.style.width = `${Math.round(newW)}px`;
    }

    endSplitDrag() {
        if (!this._splitDragging) return;
        this._splitDragging = false;
        document.removeEventListener('mousemove', this._onSplitMove);
        try {
            const rect = this.queueElement.getBoundingClientRect();
            localStorage.setItem('model_linker_split_w', String(Math.round(rect.width)));
        } catch (e) { }
        try { document.body.style.userSelect = this._prevUserSelect || ''; } catch (e) { }
    }

    /**
     * Queue a resolution for later batch apply
     */
    queueResolution(missing, resolvedModel) {
        if (!resolvedModel) {
            this.showNotification('No model selected', 'error');
            return;
        }

        const resolution = {
            node_id: missing.node_id,
            widget_index: missing.widget_index,
            resolved_path: resolvedModel.path,
            category: missing.category,
            resolved_model: resolvedModel,
            original_path: missing.original_path,
            subgraph_id: missing.subgraph_id,
            is_top_level: missing.is_top_level,
            node_type: missing.node_type,
            node_label: missing.subgraph_name || missing.node_type
        };

        const key = `${resolution.node_id}:${resolution.widget_index}:${resolution.subgraph_id || ''}:${resolution.is_top_level ? 'T' : 'F'}`;
        if (this.pendingIndex.has(key)) {
            // replace existing selection for this slot
            const idx = this.pendingIndex.get(key);
            this.pendingResolutions[idx] = resolution;
        } else {
            this.pendingIndex.set(key, this.pendingResolutions.length);
            this.pendingResolutions.push(resolution);
        }

        // Update selected bar UI
        this.updateSelectedBarForMissing?.(missing);
        this.updateQueuePanel();
        this.updateApplyPendingButton();
    }

    /**
     * Apply all pending resolutions in batch
     */
    async applyPendingResolutions() {
        const list = this.pendingResolutions || [];
        if (!list.length) {
            this.showNotification('No selections queued', 'error');
            return;
        }

        try {
            const workflow = this.getCurrentWorkflow();
            if (!workflow) {
                this.showNotification('No workflow loaded', 'error');
                return;
            }

            const response = await api.fetchApi('/model_linker/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow, resolutions: list })
            });

            if (!response.ok) throw new Error(`API error: ${response.status}`);

            const data = await response.json();
            if (data.success) {
                await this.updateWorkflowInComfyUI(data.workflow);
                this.showNotification(`✓ Linked ${list.length} selection${list.length>1?'s':''}`, 'success');
                // Clear queue and refresh analysis
                this.pendingResolutions = [];
                this.pendingIndex = new Map();
                this.updateApplyPendingButton();
                this.updateQueuePanel();
                await this.loadWorkflowData(data.workflow);
            } else {
                this.showNotification('Failed to apply selections: ' + (data.error || 'Unknown error'), 'error');
            }
        } catch (e) {
            console.error('Model Linker: applyPendingResolutions error', e);
            this.showNotification('Error applying selections: ' + e.message, 'error');
        }
    }

    updateApplyPendingButton() {
        if (!this.applyPendingBtn) return;
        const count = this.pendingResolutions?.length || 0;
        this.applyPendingBtn.textContent = `Apply Selected (${count})`;
        this.applyPendingBtn.disabled = count === 0;
    }
    
    createFooter() {
        // Store reference to download all button so we can update its text
        this.downloadAllButton = $el("button.ml-btn.ml-btn-download.ml-footer-btn", {
            onclick: () => this.handleDownloadAllClick()
        }, [
            $el("span.ml-btn-icon", { textContent: "☁" }),
            $el("span", { textContent: " Download All Missing" })
        ]);
        
        // Auto-resolve button (secondary style)
        this.autoResolveButton = $el("button.ml-btn.ml-btn-secondary.ml-footer-btn", {
            onclick: () => this.autoResolve100Percent()
        }, [
            $el("span.ml-btn-icon", { textContent: "🔗" }),
            $el("span", { textContent: " Auto-Link 100%" })
        ]);
        
        // Apply pending resolutions button
        this.applyPendingBtn = $el("button.ml-btn.ml-btn-primary.ml-footer-btn", {
            id: "apply-pending-resolutions",
            textContent: "Apply Selected (0)",
            onclick: () => this.applyPendingResolutions()
        });
        
        return $el("div.ml-footer", {
            style: {
                position: "sticky",
                bottom: "0",
                backgroundColor: "var(--ml-bg, #222)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)"
            }
        }, [
            this.autoResolveButton,
            this.applyPendingBtn,
            this.downloadAllButton
        ]);
    }

    animateTabContentTransition() {
        if (!this.contentElement?.animate) return;

        try {
            this.contentElement.animate(
                [
                    { opacity: 0.72, transform: 'translateY(7px)' },
                    { opacity: 1, transform: 'translateY(0)' }
                ],
                {
                    duration: 180,
                    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
                }
            );
        } catch (error) {
            console.warn('Model Linker: tab content animation failed', error);
        }
    }
    
    /**
     * Handle click on Download All / Cancel All button
     */
    handleDownloadAllClick() {
        if (Object.keys(this.activeDownloads).length > 0) {
            // Cancel all active downloads
            this.cancelAllDownloads();
        } else {
            // Start downloading all missing
            this.downloadAllMissing();
        }
    }
    
    /**
     * Cancel all active downloads
     */
    async cancelAllDownloads() {
        const downloadIds = Object.keys(this.activeDownloads);
        if (downloadIds.length === 0) return;
        
        this.showNotification(`Cancelling ${downloadIds.length} download${downloadIds.length > 1 ? 's' : ''}...`, 'info');
        
        for (const downloadId of downloadIds) {
            try {
                await api.fetchApi(`/model_linker/cancel/${downloadId}`, {
                    method: 'POST'
                });
            } catch (error) {
                console.error('Model Linker: Error cancelling download:', error);
            }
        }
    }
    
    /**
     * Update the Download All button state based on active downloads
     */
    updateDownloadAllButtonState() {
        if (!this.downloadAllButton) return;
        
        const activeCount = Object.keys(this.activeDownloads).length;
        if (activeCount > 0) {
            this.downloadAllButton.innerHTML = `<span class="ml-btn-icon">✕</span> Cancel All (${activeCount})`;
            this.downloadAllButton.classList.remove('ml-btn-download');
            this.downloadAllButton.classList.add('ml-btn-danger');
        } else {
            this.downloadAllButton.innerHTML = `<span class="ml-btn-icon">☁</span> Download All Missing`;
            this.downloadAllButton.classList.remove('ml-btn-danger');
            this.downloadAllButton.classList.add('ml-btn-download');
        }
    }
    
    async show(workflow = null) {
        this.backdrop.style.display = "block";
        this.element.style.display = "flex";
        
        // Update button state in case there are active downloads
        this.updateDownloadAllButtonState();
        
        // Ensure all models are loaded for dropdown
        await this.ensureCapabilitiesLoaded();
        await this.ensureAllModelsLoaded();
        await this.ensureDownloadDirectoriesLoaded();
        
        // Always default to Missing Models tab when opening dialog
        if (this.activeTab !== 'missing') {
            // Manually switch tab without loading
            this.activeTab = 'missing';
            this.missingTab.classList.add('ml-tab-active');
            this.loadedTab.classList.remove('ml-tab-active');
            this.downloadAllButton.style.display = 'inline-flex';
            this.autoResolveButton.style.display = 'inline-flex';
        }
        
        // Restore fullscreen state if enabled
        try {
            const fs = localStorage.getItem('model_linker_modal_fullscreen');
            if (fs === '1') this.setFullScreen(true);
        } catch (e) { }
        
        // Attach drag handle event listener (only once)
        this.attachDragHandleIfNeeded();
        
        // Use provided workflow or fetch from current graph
        await this.loadWorkflowData(workflow);
    }
    
    // Attach drag handle event listeners
    attachDragHandleIfNeeded() {
        if (this._dragHandleAttached) return;
        
        const handle = document.getElementById('model-linker-drag-handle');
        if (!handle) return;
        
        const onMouseDown = (e) => {
            if (this.fullscreen) return; // no drag in fullscreen
            handle.style.cursor = 'grabbing';
            this.startDrag(e);
        };
        const onMouseUp = () => { handle.style.cursor = 'grab'; };
        
        handle.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mouseup', onMouseUp, { once: true });
        
        this._dragHandleAttached = true;
    }
    
    close() {
        this._hidePreview?.();
        this.backdrop.style.display = "none";
        this.element.style.display = "none";
    }

    /**
     * Load workflow data and display missing models
     */
    async loadWorkflowData(workflow = null) {
        if (!this.contentElement) return;

        // Show loading state
        try {
            // Use provided workflow, or get current workflow from ComfyUI
            if (!workflow) {
                workflow = this.getCurrentWorkflow();
            }
            
            if (!workflow) {
                this._analysisProgressToken = null;
                this.contentElement.innerHTML = '<p>No workflow loaded. Please load a workflow first.</p>';
                return;
            }

            const workflowSignature = this.getWorkflowSignature(workflow);
            if (
                workflowSignature &&
                this.cachedWorkflowSignature === workflowSignature &&
                this.cachedAnalysisData
            ) {
                this.displayMissingModels(this.contentElement, this.cachedAnalysisData);
                this.reconnectActiveDownloads();
                return;
            }

            const analysisId = `an-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this._analysisProgressToken = analysisId;
            this.contentElement.innerHTML = this.renderAnalysisProgress({
                status: 'starting',
                message: 'Starting analysis...',
                current: 0,
                total: 0
            });

            // Call analyze endpoint
            const progressPromise = this.pollAnalysisProgress(analysisId, analysisId);
            const response = await api.fetchApi('/model_linker/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow, analysis_id: analysisId })
            });
            this._analysisProgressToken = null;
            await progressPromise;

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            this.cachedWorkflowSignature = workflowSignature;
            this.cachedAnalysisData = data;
            this.searchResultCache.clear();
            this.displayMissingModels(this.contentElement, data);
            
            // Reconnect any active downloads to their new progress divs
            this.reconnectActiveDownloads();

        } catch (error) {
            this._analysisProgressToken = null;
            console.error('Model Linker: Error loading workflow data:', error);
            if (this.contentElement) {
                this.contentElement.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
            }
        }
    }

    /**
     * Get current workflow from ComfyUI
     */
    getCurrentWorkflow() {
        // Try to get workflow from app
        if (app?.graph) {
            try {
                // Use ComfyUI's workflow serialization
                const workflow = app.graph.serialize();
                return workflow;
            } catch (e) {
                console.warn('Model Linker: Could not serialize workflow from graph:', e);
            }
        }
        return null;
    }

    /**
     * Locate and focus a node in the ComfyUI canvas
     */
    locateNodeInGraph(nodeId) {
        try {
            if (!app?.graph) {
                this.showNotification('Cannot locate node - graph not available', 'error');
                return;
            }
            
            // Find the node in the graph
            const node = app.graph.getNodeById(nodeId);
            if (!node) {
                this.showNotification(`Node #${nodeId} not found in graph`, 'error');
                return;
            }
            
            // Focus on the node in the canvas
            if (app.canvas && typeof app.canvas.centerOnNode === 'function') {
                // Modern ComfyUI versions
                app.canvas.centerOnNode(node);
            } else if (app.graph._nodes && app.graph._nodes.get(nodeId)) {
                // Alternative method for older versions
                const canvasNode = app.graph._nodes.get(nodeId);
                if (canvasNode && canvasNode.setSelected && canvasNode.graph) {
                    canvasNode.setSelected(true);
                    // Scroll to node
                    app.canvas.scrollToNode(canvasNode);
                }
            } else if (app.ui && app.ui.nodeGraph && typeof app.ui.nodeGraph.scrollToNode === 'function') {
                // Alternative for other versions
                app.ui.nodeGraph.scrollToNode(node);
            }
            
            // Also try to flash/select the node
            // Deselect all nodes first
            if (app.graph && app.graph.nodes) {
                app.graph.nodes.forEach(n => {
                    if (n.selected) n.selected = false;
                });
            }
            
            // Select and highlight our node
            node.selected = true;
            
            this.showNotification(`Focused on Node #${nodeId} (${node.type})`, 'info');
        } catch (e) {
            console.error('Model Linker: Error locating node:', e);
            this.showNotification('Error locating node: ' + e.message, 'error');
        }
    }

    /**
     * Reconnect active downloads to their new progress div elements after UI refresh
     */
    reconnectActiveDownloads() {
        if (!this.contentElement) return;
        
        for (const [downloadId, info] of Object.entries(this.activeDownloads)) {
            const { missing } = info;
            if (!missing) continue;
            
            // Find the new progress div by ID
            const progressId = `download-progress-${missing.node_id}-${missing.widget_index}`;
            const newProgressDiv = this.contentElement.querySelector(`#${progressId}`);
            const newDownloadBtn = this.contentElement.querySelector(`#download-${missing.node_id}-${missing.widget_index}`);
            
            if (newProgressDiv) {
                // Update the reference
                info.progressDiv = newProgressDiv;
                info.downloadBtn = newDownloadBtn;
                
                // Show that download is in progress
                newProgressDiv.style.display = 'block';
                newProgressDiv.innerHTML = `
                    <div class="ml-progress-container">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div class="ml-progress-bar" style="flex: 1;">
                                <div class="ml-progress-fill" style="width: 0%;"></div>
                            </div>
                            <button class="cancel-download-btn ml-btn ml-btn-danger ml-btn-sm" data-download-id="${downloadId}">
                                Cancel
                            </button>
                        </div>
                        <div class="ml-progress-text">
                            <span style="color: #2196F3;">Downloading...</span>
                        </div>
                    </div>
                `;
                
                // Attach cancel handler
                const cancelBtn = newProgressDiv.querySelector('.cancel-download-btn');
                if (cancelBtn) {
                    cancelBtn.addEventListener('click', () => this.cancelDownload(downloadId));
                }
                
                // Update download button if exists
                if (newDownloadBtn) {
                    newDownloadBtn.disabled = true;
                    newDownloadBtn.textContent = 'Downloading...';
                }
            }
        }
    }
    
    /**
     * Display missing models in the dialog
     */
    displayMissingModels(container, data) {
        const missingModels = data.missing_models || [];
        const totalMissing = data.total_missing || 0;
        this.missingModels = missingModels;
        
        // Check if there are active downloads
        const activeCount = Object.keys(this.activeDownloads).length;
        
        // Check if any model has a 100% confidence match
        const hasAny100Match = missingModels.some(m => 
            (m.matches || []).some(match => match.confidence === 100)
        );
        
        // Show/hide Auto-Link button based on whether 100% matches exist
        if (this.autoResolveButton) {
            this.autoResolveButton.style.display = hasAny100Match ? 'inline-flex' : 'none';
        }
        
        // Hide download all button if no missing models
        if (this.downloadAllButton) {
            this.downloadAllButton.style.display = totalMissing > 0 ? 'inline-flex' : 'none';
        }

        if (totalMissing === 0 && activeCount === 0) {
            container.innerHTML = this.renderStatusMessage('All models are available! No missing models found.', 'success');
            return;
        }
        
        // If no missing models but downloads are active, show a waiting message
        if (totalMissing === 0 && activeCount > 0) {
            container.innerHTML = this.renderStatusMessage(
                `${activeCount} download${activeCount > 1 ? 's' : ''} in progress. Models will be auto-linked when complete.`,
                'info'
            );
            return;
        }

        // Summary header with count
        let html = `
            <div class="ml-missing-summary">
                <div class="ml-missing-summary-title">
                    <span class="ml-missing-summary-count">${totalMissing} Missing Model${totalMissing > 1 ? 's' : ''}</span>
                    <span class="ml-missing-summary-meta">Compact relinking and download view</span>
                </div>
                <div class="ml-missing-summary-meta">
                    ${activeCount > 0 ? `${activeCount} downloading` : (hasAny100Match ? 'Auto-Link ready for exact matches' : 'Review matches or search online')}
                </div>
            </div>
        `;
        html += '<div style="display: flex; flex-direction: column; gap: 10px;">';

        // Skip rendering if active tab is not "missing"
        if (this.activeTab !== 'missing') {
            container.innerHTML = '';
            return;
        }

        // Sort missing models: those with 100% confidence matches first, then others
        const sortedMissingModels = missingModels.sort((a, b) => {
            const aMatches = a.matches || [];
            const bMatches = b.matches || [];
            
            // Filter to 70%+ confidence
            const aFiltered = aMatches.filter(m => m.confidence >= 70);
            const bFiltered = bMatches.filter(m => m.confidence >= 70);
            
            // Check if they have 100% matches
            const aHas100 = aFiltered.some(m => m.confidence === 100);
            const bHas100 = bFiltered.some(m => m.confidence === 100);
            
            // If one has 100% and the other doesn't, prioritize the one with 100%
            if (aHas100 && !bHas100) return -1;
            if (!aHas100 && bHas100) return 1;
            
            // If both have 100% or neither has 100%, sort by best confidence
            const aBestConf = aFiltered.length > 0 ? Math.max(...aFiltered.map(m => m.confidence)) : 0;
            const bBestConf = bFiltered.length > 0 ? Math.max(...bFiltered.map(m => m.confidence)) : 0;
            
            return bBestConf - aBestConf; // Higher confidence first
        });

        for (let mi = 0; mi < sortedMissingModels.length; mi++) {
            sortedMissingModels[mi].__displayIndex = mi;
            html += this.renderMissingModel(sortedMissingModels[mi], mi);
        }

        html += '</div>';
        container.innerHTML = html;

        // Attach event listeners for resolve buttons (use sorted order)
        // Note: We need to match the exact same logic as renderMissingModel to find which buttons were rendered
        sortedMissingModels.forEach((missing, missingIndex) => {
            this.wireLocalMatchButtons(container, missing, missingIndex);
            
            // Attach download button listener
            const downloadBtnId = `download-${missing.node_id}-${missing.widget_index}`;
            const downloadBtn = container.querySelector(`#${downloadBtnId}`);
            if (downloadBtn && missing.download_source) {
                downloadBtn.addEventListener('click', () => {
                    this.downloadModel(missing);
                });
            }
            
            // Attach search button listener
            const searchBtnId = `search-${missing.node_id}-${missing.widget_index}`;
            const searchBtn = container.querySelector(`#${searchBtnId}`);
            if (searchBtn) {
                searchBtn.addEventListener('click', () => {
                    this.searchOnline(missing);
                });
            }

            const sourceSelect = container.querySelector(`#search-source-select-${missing.node_id}-${missing.widget_index}`);
            if (sourceSelect) {
                sourceSelect.addEventListener('change', () => {
                    this.setSearchSource(missing, sourceSelect.value, container);
                });
                this.syncSearchSourceUi(missing, container);
            }

            this.wireDownloadTargetAutocomplete(container, missing);
            
            // Wire locate chip (only for top-level nodes)
            const locateId = `locate-${missing.node_id}-${missing.widget_index}`;
            const locateBtn = container.querySelector(`#${locateId}`);
            if (locateBtn && missing.is_top_level !== false) {
                locateBtn.addEventListener('click', () => {
                    this.locateNodeInGraph(missing.node_id);
                });
            }
            
            // Wire up all-models search + dropdown (combo-style)
            const comboId = `combo-${missing.node_id}-${missing.widget_index}`;
            const comboInput = container.querySelector(`#combo-input-${comboId}`);
            const comboList = container.querySelector(`#combo-list-${comboId}`);
            const comboRefresh = container.querySelector(`#combo-refresh-${comboId}`);

            const allModels = Array.isArray(this.allModels) ? this.allModels : [];
            const buildLabel = (m) => `${m.category ? m.category + ': ' : ''}${m.relative_path || m.filename || ''}`;
            const getFolder = (m) => m.path || m.base_directory || '';

            // Populate dropdown with filtered models
            const populateComboOptions = (filterText, highlightIdx = -1) => {
                if (!comboList) return;
                const f = (filterText || '').toLowerCase();
                const filtered = f
                    ? allModels.filter(m => buildLabel(m).toLowerCase().includes(f))
                    : allModels.slice();  // Copy to avoid mutation
                
                let html = '';
                for (let i = 0; i < filtered.length; i++) {
                    const m = filtered[i];
                    const label = buildLabel(m);
                    const folder = getFolder(m);
                    const isHighlighted = i === highlightIdx;
                    const folderDisplay = folder ? folder.replace(/\\/g, '/').replace(/:/, '') : '';
                    html += `<div data-idx="${allModels.indexOf(m)}" class="ml-combo-option ${isHighlighted ? 'is-highlighted' : ''}">`;
                    html += `<div class="ml-combo-option-row">`;
                    html += `<code>${label}</code>`;
                    html += `</div>`;
                    if (folderDisplay) {
                        html += `<div class="ml-combo-folder" title="${folderDisplay}">📁 ${folderDisplay}</div>`;
                    }
                    html += `</div>`;
                }
                comboList.innerHTML = html;
                
                // Add click listeners to options
                comboList.querySelectorAll('div[data-idx]').forEach(el => {
                    el.addEventListener('click', () => {
                        const idx = parseInt(el.dataset.idx, 10);
                        if (!isNaN(idx) && idx >= 0 && idx < allModels.length) {
                            const chosenModel = allModels[idx];
                            if (chosenModel) {
                                this.queueResolution(missing, chosenModel);
                            }
                        }
                    });
                });
            };

            // Initial populate
            if (comboList) {
                populateComboOptions('');
            }

            // Filter input with debounce
            if (comboInput) {
                const debouncedFilter = this.debounce(() => {
                    populateComboOptions(comboInput.value);
                }, 200);
                comboInput.addEventListener('input', debouncedFilter);
                
                // Show dropdown on focus
                comboInput.addEventListener('focus', () => {
                    if (comboList) comboList.style.display = 'block';
                    populateComboOptions(comboInput.value);
                });
                
                // Close on blur (with delay to allow click)
                comboInput.addEventListener('blur', () => {
                    setTimeout(() => {
                        if (comboList) comboList.style.display = 'none';
                    }, 200);
                });
            }

            // Refresh button - reload all models
            if (comboRefresh) {
                comboRefresh.addEventListener('click', async () => {
                    this.allModels = null;  // Force reload
                    await this.ensureAllModelsLoaded();
                    populateComboOptions(comboInput?.value || '');
                });
            }
        });
    }

    /**
     * Render a single missing model entry
     */
    renderMissingModel(missing, missingIndex = 0) {
        const allMatches = missing.matches || [];
        
        // Filter out matches below 70% confidence threshold
        const filteredMatches = allMatches.filter(m => m.confidence >= 70);
        const hasMatches = filteredMatches.length > 0;
        
        // Calculate 100% matches upfront (needed for download section)
        const perfectMatches = filteredMatches.filter(m => m.confidence === 100);
        const otherMatches = filteredMatches.filter(m => m.confidence < 100 && m.confidence >= 70);
        
        // Format the missing filename for display
        const missingFilename = this.formatFilename(missing.original_path, 60);
        
        // Determine node info for the chip
        const isSubgraphNode = missing.node_type && missing.node_type.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        let nodeLabel;
        if (missing.subgraph_name) {
            nodeLabel = missing.subgraph_name;
        } else if (isSubgraphNode) {
            nodeLabel = 'Subgraph';
        } else {
            nodeLabel = missing.node_type || 'Node';
        }
        
        // Start card
        let html = `<div class="ml-card">`;
        
        // Card Header: Filename as headline + node chip
        html += `<div class="ml-card-header">`;
        html += `<div class="ml-card-title-wrap">`;
        
        const titleMetaParts = [];
        let titlePrimaryHtml = `<span class="ml-card-title-primary" title="${missingFilename.full}">${missingFilename.display}</span>`;
        let titleSecondaryHtml = '';
        
        const modelId = missing.urn_model_id || missing.urn?.model_id;
        const versionId = missing.urn_version_id || missing.urn?.version_id;
        const modelUrl = missing.is_urn && modelId ? `https://civitai.com/models/${modelId}${versionId ? '?modelVersionId=' + versionId : ''}` : '';
        const urnLoadingId = `urn-loading-${missing.node_id}-${missing.widget_index}`;

        if (missing.is_urn) {
            titleMetaParts.push(`<span class="ml-card-title-eyebrow" title="${missingFilename.full}">${missingFilename.display}</span>`);
        }
        
        if (missing.is_urn && !missing.civitai_info) {
            // URN without info - show Loading and fetch async in background
            titlePrimaryHtml = `<span class="ml-card-title-primary" id="${urnLoadingId}">Resolving CivitAI model...</span>`;
            setTimeout(() => this.resolveUrnAsync(modelId, versionId, urnLoadingId, modelUrl), 10);
        } else if (missing.is_urn && missing.civitai_info) {
            // URN with resolved info - show model name/version
            const civitaiInfo = missing.civitai_info;
            let civitaiLabel = '';
            if (civitaiInfo.model_name) {
                civitaiLabel += civitaiInfo.model_name;
            }
            if (civitaiInfo.version_name && civitaiInfo.version_name !== civitaiInfo.model_name) {
                civitaiLabel += ` v${civitaiInfo.version_name}`;
            }
            if (civitaiLabel) {
                const linkHtml = modelUrl ? `<a href="${modelUrl}" target="_blank" class="ml-inline-civitai-link">${civitaiLabel}</a>` : `<span class="ml-inline-civitai-link">${civitaiLabel}</span>`;
                titlePrimaryHtml = `<span class="ml-card-title-primary">${linkHtml}</span>`;
            }
            if (civitaiInfo.expected_filename) {
                titleSecondaryHtml = `<span class="ml-card-title-secondary">Expected file: ${civitaiInfo.expected_filename}</span>`;
            }
        }
        
        html += `<div class="ml-card-title-meta">`;
        html += titleMetaParts.join('');
        html += `<h3 class="ml-card-title">${titlePrimaryHtml}</h3>`;
        if (titleSecondaryHtml) {
            html += titleSecondaryHtml;
        }
        html += `</div>`;
        const locateId = `locate-${missing.node_id}-${missing.widget_index}`;
        const nodeChipClasses = missing.is_top_level !== false ? 'ml-node-chip is-locatable' : 'ml-node-chip';
        const nodeChipTitle = missing.is_top_level !== false ? 'Click to locate this node in the graph' : '';

        html += `<div class="ml-card-subtitle">`;
        if (missing.category) {
            html += `<span class="ml-category-chip">${missing.category}</span>`;
        }
        html += `<span id="${locateId}" class="${nodeChipClasses}"${nodeChipTitle ? ` title="${nodeChipTitle}"` : ''}>`;
        if (missing.is_top_level !== false) {
            html += `<span class="ml-node-chip-icon">⌖</span>`;
        }
        html += `${nodeLabel} #${missing.node_id}</span>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;
        
        // Selected bar - shows if this slot has a queued selection (BELOW card header)
        const selectedBarId = `selected-bar-${missing.node_id}-${missing.widget_index}`;
        html += `<div id="${selectedBarId}" class="model-linker-selected" style="display: none;"></div>`;
        
        // Two-column layout
        html += `<div class="ml-columns">`;
        
        // LEFT COLUMN: Local Matches
        html += `<div class="ml-column">`;
        html += `<div class="ml-column-header">Local Matches</div>`;
        html += `<div id="local-matches-body-${missing.node_id}-${missing.widget_index}">`;
        html += this.renderLocalMatchesContent(missing, missingIndex);
        html += `</div>`;
        
        // Add all-models search picker - combo-style dropdown
        const comboId = `combo-${missing.node_id}-${missing.widget_index}`;
        html += `<div class="ml-combo-section">`;
        html += `<div class="ml-combo-row">`;
        html += `<label class="ml-combo-label">Model</label>`;
        html += `<input id="combo-input-${comboId}" class="ml-combo-input" type="text" placeholder="Type to filter local models...">`;
        html += `<button id="combo-refresh-${comboId}" title="Refresh model list" class="ml-btn ml-btn-secondary ml-btn-sm ml-btn-icon-only">⟳</button>`;
        html += `</div>`;
        html += `<div id="combo-list-${comboId}" class="ml-combo-list"></div>`;
        html += `</div>`;
        
        html += `</div>`; // End left column
        
        // RIGHT COLUMN: Download Option
        html += `<div class="ml-column">`;
        html += `<div class="ml-column-header">Download</div>`;
        
        const filename = missing.original_path?.split('/').pop()?.split('\\').pop() || '';
        const downloadSource = missing.download_source;
        const urnDownloadId = `urn-download-${missing.node_id}-${missing.widget_index}`;
        
        if (perfectMatches.length > 0) {
            // Has perfect local match - download not needed
            html += `<div class="ml-download-section">`;
            html += `<div class="ml-status-inline">`;
            html += this.getStatusBadge('Not needed', 'neutral');
            html += `<span class="ml-download-info">Exact local match available</span>`;
            html += `</div>`;
            html += `</div>`;
        } else if (downloadSource && downloadSource.url) {
            html += this.renderDownloadSourceSection(missing, downloadSource);
        } else if (missing.is_urn) {
            html += `<div id="${urnDownloadId}" class="ml-download-section">`;
            html += `<div class="ml-download-info">Resolving CivitAI download for this URN...</div>`;
            html += `</div>`;
        } else {
            // No known download - offer search
            html += `<div class="ml-download-section">`;
            const searchSourcesId = `search-sources-${missing.node_id}-${missing.widget_index}`;
            const searchSourceSelectId = `search-source-select-${missing.node_id}-${missing.widget_index}`;
            html += `<div id="${searchSourcesId}" class="ml-search-source-bar">`;
            html += `<button id="search-${missing.node_id}-${missing.widget_index}" class="ml-btn ml-btn-link">`;
            html += `${this.getSearchIconHtml()} Search`;
            html += `</button>`;
            html += `<div class="ml-search-source-picker">`;
            html += `<label class="ml-search-source-picker-label" for="${searchSourceSelectId}">Source</label>`;
            html += `<select id="${searchSourceSelectId}" class="ml-search-source-select">`;
            html += `<option value="all">Everything</option>`;
            html += `<option value="local">Local Database</option>`;
            html += `<option value="huggingface">HuggingFace</option>`;
            html += `<option value="civitai">CivitAI</option>`;
            if (this.isSourceAvailable('lora_manager_archive')) {
                html += `<option value="lora_manager_archive">LoRA Manager Archive</option>`;
            }
            html += `</select>`;
            html += `</div>`;
            html += `</div>`;
            html += this.renderDownloadTargetControls(missing, missing.category || 'checkpoints');
            html += `</div>`;
            html += `<div id="search-results-${missing.node_id}-${missing.widget_index}" class="ml-search-results"></div>`;
        }
        
        // Progress container (for downloads)
        html += `<div id="download-progress-${missing.node_id}-${missing.widget_index}" style="margin-top: 8px; display: none;"></div>`;
        
        html += `</div>`; // End right column
        html += `</div>`; // End columns
        
        html += `</div>`; // End card
        return html;
    }

    /**
     * Show a notification banner (similar to ComfyUI's "Reconnecting" banner)
     */
    showNotification(message, type = 'success') {
        // Build children array, filtering out nulls
        const children = [];
        
        if (type === 'success') {
            children.push($el("span", {
                textContent: "✓",
                style: {
                    fontSize: "18px",
                    fontWeight: "bold"
                }
            }));
        } else if (type === 'error') {
            children.push($el("span", {
                textContent: "×",
                style: {
                    fontSize: "18px",
                    fontWeight: "bold"
                }
            }));
        } else if (type === 'info') {
            children.push($el("span", {
                textContent: "ℹ",
                style: {
                    fontSize: "18px",
                    fontWeight: "bold"
                }
            }));
        }
        
        // Create notification banner
        const notification = $el("div", {
            style: {
                position: "fixed",
                top: "0",
                left: "50%",
                transform: "translateX(-50%)",
                backgroundColor: type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#007acc',
                color: "#ffffff",
                padding: "12px 24px",
                borderRadius: "0 0 8px 8px",
                fontSize: "14px",
                fontWeight: "500",
                zIndex: "100000",
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                display: "flex",
                alignItems: "center",
                gap: "12px",
                minWidth: "300px",
                maxWidth: "600px",
                textAlign: "center",
                animation: "slideDown 0.3s ease"
            }
        }, [
            ...children,
            $el("span", {
                textContent: message
            }),
            $el("button", {
                textContent: "×",
                onclick: () => {
                    if (notification.parentNode) {
                        notification.style.opacity = "0";
                        notification.style.transform = "translateX(-50%) translateY(-100%)";
                        setTimeout(() => {
                            if (notification.parentNode) {
                                notification.parentNode.removeChild(notification);
                            }
                        }, 300);
                    }
                },
                style: {
                    background: "none",
                    border: "none",
                    color: "#ffffff",
                    fontSize: "20px",
                    cursor: "pointer",
                    padding: "0",
                    marginLeft: "auto",
                    opacity: "0.8",
                    width: "24px",
                    height: "24px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "4px"
                }
            })
        ]);

        // Add CSS animation if not already added
        if (!document.getElementById('model-linker-notification-style')) {
            const style = $el("style", {
                id: 'model-linker-notification-style',
                textContent: `
                    @keyframes slideDown {
                        from {
                            opacity: 0;
                            transform: translateX(-50%) translateY(-100%);
                        }
                        to {
                            opacity: 1;
                            transform: translateX(-50%) translateY(0);
                        }
                    }
                `
            });
            document.head.appendChild(style);
        }

        document.body.appendChild(notification);

        // Auto-dismiss after 4 seconds for success, 6 seconds for errors
        const dismissTime = type === 'success' ? 4000 : 6000;
        setTimeout(() => {
            if (notification.parentNode) {
                notification.style.opacity = "0";
                notification.style.transform = "translateX(-50%) translateY(-100%)";
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 300);
            }
        }, dismissTime);
    }

    /**
     * Resolve a model - resolves ALL nodes that reference this model
     */
    async resolveModel(missing, resolvedModel) {
        console.log('resolveModel called:', missing?.original_path, '->', resolvedModel?.filename);
        
        if (!resolvedModel) {
            this.showNotification('No resolved model selected', 'error');
            return;
        }

        try {
            const workflow = this.getCurrentWorkflow();
            if (!workflow) {
                this.showNotification('No workflow loaded', 'error');
                return;
            }

            // Resolve ALL nodes that need this model (all_node_refs contains deduplicated refs)
            const nodeRefs = missing.all_node_refs || [missing];
            console.log('nodeRefs count:', nodeRefs?.length, 'is_lora_v2:', nodeRefs?.[0]?.is_lora_v2);
            
            const resolutions = nodeRefs.map(ref => ({
                node_id: ref.node_id,
                widget_index: ref.widget_index,
                resolved_path: resolvedModel.path,
                category: ref.category,
                resolved_model: resolvedModel,
                subgraph_id: ref.subgraph_id,
                is_top_level: ref.is_top_level,
                is_lora_v2: ref.is_lora_v2,
                original_lora_name: ref.name || ref.original_path
            }));

            const response = await api.fetchApi('/model_linker/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workflow,
                    resolutions: resolutions
                })
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            console.log('Resolve response: success=', data.success, ' missing count:', data.workflow?.nodes?.length);
            
            if (data.success) {
                // Update workflow in ComfyUI
                await this.updateWorkflowInComfyUI(data.workflow);
                
                // Show success notification
                const modelName = resolvedModel.relative_path || resolvedModel.filename || 'model';
                const count = resolutions.length;
                const refText = count > 1 ? ` (${count} references)` : '';
                this.showNotification(`✓ Model linked successfully: ${modelName}${refText}`, 'success');
                
                // Reload dialog using the updated workflow from API response
                // This ensures we're analyzing the correct updated workflow
                await this.loadWorkflowData(data.workflow);
            } else {
                this.showNotification('Failed to resolve model: ' + (data.error || 'Unknown error'), 'error');
            }

        } catch (error) {
            console.error('Model Linker: Error resolving model:', error);
            this.showNotification('Error resolving model: ' + error.message, 'error');
        }
    }

    /**
     * Auto-resolve all 100% confidence matches
     * @returns {object|null} The updated workflow if successful, null otherwise
     */
    async autoResolve100Percent() {
        try {
            const workflow = this.getCurrentWorkflow();
            if (!workflow) {
                this.showNotification('No workflow loaded', 'error');
                return null;
            }

            // Analyze workflow first
            const analyzeResponse = await api.fetchApi('/model_linker/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow })
            });

            if (!analyzeResponse.ok) {
                throw new Error(`API error: ${analyzeResponse.status}`);
            }

            const analyzeData = await analyzeResponse.json();
            const missingModels = analyzeData.missing_models || [];

            // Collect all 100% matches
            const resolutions = [];
            for (const missing of missingModels) {
                const matches = missing.matches || [];
                const perfectMatch = matches.find((m) => m.confidence === 100);
                
                if (perfectMatch && perfectMatch.model) {
                    resolutions.push({
                        node_id: missing.node_id,
                        widget_index: missing.widget_index,
                        resolved_path: perfectMatch.model.path,
                        category: missing.category,
                        resolved_model: perfectMatch.model,
                        subgraph_id: missing.subgraph_id,  // Include subgraph_id for subgraph nodes
                        is_top_level: missing.is_top_level,  // True for top-level nodes, False for nodes in subgraph definitions
                        is_lora_v2: missing.is_lora_v2,
                        original_lora_name: missing.name || missing.original_path
                    });
                }
            }

            if (resolutions.length === 0) {
                this.showNotification('No 100% confidence matches found to auto-resolve.', 'error');
                return null;
            }

            // Apply resolutions
            const resolveResponse = await api.fetchApi('/model_linker/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workflow,
                    resolutions
                })
            });

            if (!resolveResponse.ok) {
                throw new Error(`API error: ${resolveResponse.status}`);
            }

            const resolveData = await resolveResponse.json();
            
            if (resolveData.success) {
                // Update workflow in ComfyUI
                await this.updateWorkflowInComfyUI(resolveData.workflow);
                
                // Show success notification
                this.showNotification(
                    `✓ Successfully linked ${resolutions.length} model${resolutions.length > 1 ? 's' : ''}!`,
                    'success'
                );
                
                // Reload dialog using the updated workflow from API response (if dialog is visible)
                if (this.contentElement) {
                    await this.loadWorkflowData(resolveData.workflow);
                }
                
                // Return the updated workflow for callers who need it
                return resolveData.workflow;
            } else {
                this.showNotification('Failed to resolve models: ' + (resolveData.error || 'Unknown error'), 'error');
                return null;
            }

        } catch (error) {
            console.error('Model Linker: Error auto-resolving:', error);
            this.showNotification('Error auto-resolving: ' + error.message, 'error');
            return null;
        }
    }

    /**
     * Download all missing models that have download sources but no 100% local match
     */
    async downloadAllMissing() {
        if (!this.contentElement) return;

        try {
            const workflow = this.getCurrentWorkflow();
            if (!workflow) {
                this.showNotification('No workflow loaded', 'error');
                return;
            }

            // Analyze workflow first
            const analyzeResponse = await api.fetchApi('/model_linker/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow })
            });

            if (!analyzeResponse.ok) {
                throw new Error(`API error: ${analyzeResponse.status}`);
            }

            const analyzeData = await analyzeResponse.json();
            const missingModels = analyzeData.missing_models || [];

            // Collect models that need downloading:
            // - Have a download_source with valid URL
            // - Do NOT have any 100% confidence local matches
            const toDownload = [];
            for (const missing of missingModels) {
                const perfectMatches = (missing.matches || []).filter(m => m.confidence === 100);
                
                // Skip if has 100% local match or no download source
                if (perfectMatches.length > 0 || !missing.download_source?.url) {
                    continue;
                }
                
                toDownload.push(missing);
            }

            if (toDownload.length === 0) {
                this.showNotification('No models available for download (all have local matches or no download URLs).', 'info');
                return;
            }

            // Start all downloads
            this.showNotification(`Starting ${toDownload.length} download${toDownload.length > 1 ? 's' : ''}...`, 'info');
            
            for (const missing of toDownload) {
                // Use downloadModel which handles progress tracking
                this.downloadModel(missing);
            }
            
            // Update button state to show Cancel All
            this.updateDownloadAllButtonState();

        } catch (error) {
            console.error('Model Linker: Error in downloadAllMissing:', error);
            this.showNotification('Error starting downloads: ' + error.message, 'error');
        }
    }

    /**
     * Auto-resolve a model after download completes
     * Reloads the workflow analysis and resolves if the downloaded model is found
     */
    async autoResolveAfterDownload(missing, downloadedFilename) {
        try {
            const workflow = this.getCurrentWorkflow();
            if (!workflow) {
                // Just reload the UI to show updated state
                await this.loadWorkflowData();
                return;
            }

            // Re-analyze workflow to find the newly downloaded model
            const analyzeResponse = await api.fetchApi('/model_linker/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow })
            });

            if (!analyzeResponse.ok) {
                // Just reload UI
                await this.loadWorkflowData();
                return;
            }

            const analyzeData = await analyzeResponse.json();
            const missingModels = analyzeData.missing_models || [];

            // Find the missing model entry that matches our download by filename
            const targetMissing = missingModels.find(m => {
                const missingFilename = m.original_path?.split('/').pop()?.split('\\').pop() || '';
                return missingFilename.toLowerCase() === downloadedFilename.toLowerCase();
            });

            if (!targetMissing) {
                // Model no longer missing - already resolved or workflow changed
                await this.loadWorkflowData();
                return;
            }

            // Look for a 100% match with the downloaded filename
            const matches = targetMissing.matches || [];
            const perfectMatch = matches.find(m => {
                const matchFilename = m.filename || m.model?.filename || '';
                // Check for exact match or 100% confidence
                return m.confidence === 100 || 
                       matchFilename.toLowerCase() === downloadedFilename.toLowerCase();
            });

            if (perfectMatch && perfectMatch.model) {
                // Auto-resolve ALL nodes that need this model
                // all_node_refs contains all nodes referencing this model (deduplicated)
                const nodeRefs = targetMissing.all_node_refs || [targetMissing];
                const resolutions = nodeRefs.map(ref => ({
                    node_id: ref.node_id,
                    widget_index: ref.widget_index,
                    resolved_path: perfectMatch.model.path,
                    category: ref.category,
                    resolved_model: perfectMatch.model,
                    subgraph_id: ref.subgraph_id,
                    is_top_level: ref.is_top_level,
                    is_lora_v2: ref.is_lora_v2,
                    original_lora_name: ref.name || ref.original_path
                }));

                const resolveResponse = await api.fetchApi('/model_linker/resolve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        workflow,
                        resolutions: resolutions
                    })
                });

                if (resolveResponse.ok) {
                    const resolveData = await resolveResponse.json();
                    if (resolveData.success) {
                        await this.updateWorkflowInComfyUI(resolveData.workflow);
                        const count = resolutions.length;
                        this.showNotification(`✓ Auto-resolved: ${downloadedFilename} (${count} reference${count > 1 ? 's' : ''})`, 'success');
                        await this.loadWorkflowData(resolveData.workflow);
                        return;
                    }
                }
            }

            // If we couldn't auto-resolve, just reload the UI
            await this.loadWorkflowData();

        } catch (error) {
            console.error('Model Linker: Error auto-resolving after download:', error);
            // Still reload UI even on error
            await this.loadWorkflowData();
        }
    }

    /**
     * Download a model from a known source
     */
    async downloadModel(missing) {
        const source = missing.download_source;
        if (!source || !source.url) {
            this.showNotification('No download URL available', 'error');
            return;
        }

        // Use filename from download source if available (may be different from original)
        const originalFilename = missing.original_path?.split('/').pop()?.split('\\').pop() || 'model.safetensors';
        const filename = source.filename || originalFilename;
        const targetSelection = this.getDownloadTargetSelection(missing, source.directory || missing.category || 'checkpoints');
        const category = targetSelection.category;
        const subfolder = targetSelection.subfolder;
        const progressId = `download-progress-${missing.node_id}-${missing.widget_index}`;
        const progressDiv = this.contentElement?.querySelector(`#${progressId}`);
        const downloadBtn = this.contentElement?.querySelector(`#download-${missing.node_id}-${missing.widget_index}`);
        const tokens = this.getStoredTokens();

        try {
            // Disable button and show progress with cancel button immediately
            if (downloadBtn) {
                downloadBtn.disabled = true;
                downloadBtn.textContent = 'Starting...';
            }
            if (progressDiv) {
                progressDiv.style.display = 'block';
                // Show progress bar with cancel button immediately
                progressDiv.innerHTML = `
                    <div class="ml-progress-container">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div class="ml-progress-bar" style="flex: 1;">
                                <div class="ml-progress-fill" style="width: 0%;"></div>
                            </div>
                            <button class="cancel-download-btn-pending ml-btn ml-btn-danger ml-btn-sm">
                                Cancel
                            </button>
                        </div>
                        <div class="ml-progress-text">
                            <span style="color: #2196F3;">Connecting...</span>
                        </div>
                    </div>
                `;
            }

            // Start download
            const response = await api.fetchApi('/model_linker/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: source.url,
                    filename: filename,
                    category: category,
                    subfolder: subfolder,
                    hf_token: tokens.hf_token,
                    civitai_key: tokens.civitai_key
                })
            });

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'Download failed');
            }

            // Track download and poll for progress
            const downloadId = data.download_id;
            this.activeDownloads[downloadId] = { missing, progressDiv, downloadBtn };
            
            // Update the Download All button state
            this.updateDownloadAllButtonState();
            
            // Attach cancel handler to pending button (before polling replaces it)
            const pendingCancelBtn = progressDiv?.querySelector('.cancel-download-btn-pending');
            if (pendingCancelBtn) {
                pendingCancelBtn.addEventListener('click', () => this.cancelDownload(downloadId));
            }
            
            this.pollDownloadProgress(downloadId);

        } catch (error) {
            console.error('Model Linker: Download error:', error);
            if (progressDiv) {
                progressDiv.innerHTML = this.renderStatusMessage(error.message, 'error');
            }
            if (downloadBtn) {
                downloadBtn.disabled = false;
                downloadBtn.innerHTML = '<span class="ml-btn-icon">☁</span> Retry';
            }
            this.showNotification('Download failed: ' + error.message, 'error');
        }
    }

    /**
     * Poll download progress
     */
    async pollDownloadProgress(downloadId) {
        const info = this.activeDownloads[downloadId];
        if (!info) return;

        try {
            const response = await api.fetchApi(`/model_linker/progress/${downloadId}`);
            if (!response.ok) {
                throw new Error('Failed to get progress');
            }

            const progress = await response.json();
            const { progressDiv, downloadBtn, missing } = info;

            if (progress.status === 'downloading' || progress.status === 'starting') {
                const percent = progress.progress || 0;
                const downloaded = this.formatBytes(progress.downloaded || 0);
                const total = this.formatBytes(progress.total_size || 0);
                const speed = progress.speed ? this.formatBytes(progress.speed) + '/s' : '';
                
                if (progressDiv) {
                    progressDiv.innerHTML = `
                        <div class="ml-progress-container">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div class="ml-progress-bar" style="flex: 1;">
                                    <div class="ml-progress-fill" style="width: ${percent}%;"></div>
                                </div>
                                <button class="cancel-download-btn ml-btn ml-btn-danger ml-btn-sm" data-download-id="${downloadId}">
                                    Cancel
                                </button>
                            </div>
                            <div class="ml-progress-text">
                                <span>${downloaded} / ${total} (${percent}%)</span>
                                <span>${speed}</span>
                            </div>
                        </div>
                    `;
                    // Attach cancel handler
                    const cancelBtn = progressDiv.querySelector('.cancel-download-btn');
                    if (cancelBtn && !cancelBtn._hasListener) {
                        cancelBtn._hasListener = true;
                        cancelBtn.addEventListener('click', () => this.cancelDownload(downloadId));
                    }
                }
                if (downloadBtn) {
                    downloadBtn.textContent = `${percent}%`;
                }

                // Continue polling
                setTimeout(() => this.pollDownloadProgress(downloadId), 1000);

            } else if (progress.status === 'completed') {
                if (progressDiv) {
                    progressDiv.innerHTML = this.renderStatusMessage('Download complete! Auto-linking...', 'success');
                }
                if (downloadBtn) {
                    downloadBtn.textContent = '✓ Done';
                    downloadBtn.classList.add('ml-btn-primary');
                }
                delete this.activeDownloads[downloadId];
                this.updateDownloadAllButtonState();
                this.showNotification(`Downloaded: ${progress.filename}`, 'success');
                
                // Auto-resolve: Reload workflow data and try to resolve the downloaded model
                // Small delay to ensure file system is updated
                setTimeout(async () => {
                    await this.autoResolveAfterDownload(missing, progress.filename);
                }, 500);

            } else if (progress.status === 'error') {
                if (progressDiv) {
                    progressDiv.innerHTML = this.renderStatusMessage(progress.error || 'Download failed', 'error');
                }
                if (downloadBtn) {
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = 'Retry';
                }
                delete this.activeDownloads[downloadId];
                this.updateDownloadAllButtonState();

            } else if (progress.status === 'cancelled') {
                if (progressDiv) {
                    progressDiv.innerHTML = this.renderStatusMessage('Download cancelled - incomplete file removed', 'warning');
                }
                if (downloadBtn) {
                    downloadBtn.disabled = false;
                    downloadBtn.innerHTML = '<span class="ml-btn-icon">☁</span> Download';
                }
                delete this.activeDownloads[downloadId];
                this.updateDownloadAllButtonState();
                this.showNotification('Download cancelled', 'info');

            } else {
                // Unknown status, keep polling
                setTimeout(() => this.pollDownloadProgress(downloadId), 500);
            }

        } catch (error) {
            console.error('Model Linker: Progress poll error:', error);
            const info = this.activeDownloads[downloadId];
            // Update UI to show error state instead of just disappearing
            if (info) {
                const { progressDiv, downloadBtn } = info;
                if (progressDiv) {
                    progressDiv.innerHTML = this.renderStatusMessage('Connection lost - download may have failed', 'error');
                }
                if (downloadBtn) {
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = 'Retry';
                    downloadBtn.style.background = '#4CAF50';
                }
            }
            delete this.activeDownloads[downloadId];
            this.updateDownloadAllButtonState();
        }
    }

    /**
     * Cancel an active download
     */
    async cancelDownload(downloadId) {
        try {
            const response = await api.fetchApi(`/model_linker/cancel/${downloadId}`, {
                method: 'POST'
            });
            
            if (!response.ok) {
                throw new Error('Failed to cancel download');
            }
            
            const info = this.activeDownloads[downloadId];
            if (info?.progressDiv) {
                info.progressDiv.innerHTML = this.renderStatusMessage('Cancelling download...', 'info');
            }
            
        } catch (error) {
            console.error('Model Linker: Cancel error:', error);
            this.showNotification('Failed to cancel download', 'error');
        }
    }

    /**
     * Search online for a model
     */
    async searchOnline(missing) {
        let filename = missing.original_path?.split('/').pop()?.split('\\').pop() || '';
        let category = missing.category || '';
        const state = this.getSearchState(missing);
        const selectedSource = state.selectedSource || 'all';
        const selectedSourceLabel = this.getSearchSourceLabel(selectedSource);
        
        // For URNs, use the CivitAI model name for searching instead of the URN itself
        // and pass the URN type as category (CivitAI expects specific type names)
        if (missing.is_urn) {
            if (missing.civitai_info?.model_name) {
                filename = missing.civitai_info.model_name;
            }
            // Pass URN type directly - CivitAPI expects types like 'Upscaler', 'Checkpoint'
            const urnType = missing.urn_type || '';
            if (urnType) {
                // Map URN types to CivitAI type names
                const typeMap = {
                    'checkpoint': 'Checkpoint',
                    'lora': 'LORA',
                    'vae': 'VAE',
                    'upscaler': 'Upscaler',
                    'upscale_model': 'Upscaler',
                    'embedding': 'TextualInversion',
                    'controlnet': 'Controlnet'
                };
                const civitaiType = typeMap[urnType.toLowerCase()];
                if (civitaiType) {
                    category = civitaiType;
                }
            }
        }
        
        const isUrn = missing.is_urn || false;
        const resultsId = `search-results-${missing.node_id}-${missing.widget_index}`;
        const resultsDiv = this.contentElement?.querySelector(`#${resultsId}`);
        const searchBtn = this.contentElement?.querySelector(`#search-${missing.node_id}-${missing.widget_index}`);

        try {
            if (searchBtn) {
                searchBtn.disabled = true;
                searchBtn.innerHTML = `${this.getSearchIconHtml()} Searching ${selectedSourceLabel}...`;
            }
            if (resultsDiv) {
                resultsDiv.style.display = 'block';
                resultsDiv.innerHTML = `<span style="color: #2196F3;">Searching ${selectedSourceLabel}...</span>`;
            }

            // For URNs, include model_id and version_id for direct download
            const tokens = this.getStoredTokens();
            const searchData = {
                filename,
                category,
                is_urn: isUrn,
                sources: [selectedSource],
                civitai_session_token: tokens.civitai_session_token,
                civitai_candidate_limit: tokens.civitai_candidate_limit
            };
            if (isUrn && missing.urn) {
                searchData.model_id = missing.urn.model_id;
                searchData.version_id = missing.urn.version_id;
            }
            
            console.log('Model Linker: Search request:', JSON.stringify(searchData));

            const response = await api.fetchApi('/model_linker/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(searchData)
            });

            if (!response.ok) {
                throw new Error(`Search failed: ${response.status}`);
            }

            const data = await response.json();
            console.log('Model Linker: Search response:', JSON.stringify(data));
            state.results = this.mergeSearchResults(state.results, data);
            state.lastAttemptSources = Array.isArray(data.searched_sources) ? data.searched_sources : [selectedSource];
            state.lastAttemptFound = this.hasSearchResults(data);
            if (data.civitai) {
                missing.civitai_search_result = {
                    base_model: data.civitai.base_model,
                    tags: data.civitai.tags || [],
                    trained_words: data.civitai.trained_words || [],
                    filename: data.civitai.filename,
                    name: data.civitai.name,
                    type: data.civitai.type
                };
            }
            this.displaySearchResults(missing, state, resultsDiv);
            this.applySearchResultSuggestion(missing);

        } catch (error) {
            console.error('Model Linker: Search error:', error);
            if (resultsDiv) {
                resultsDiv.innerHTML = this.renderStatusMessage(`Search failed: ${error.message}`, 'error');
            }
        } finally {
            if (searchBtn) {
                searchBtn.disabled = false;
                searchBtn.innerHTML = `${this.getSearchIconHtml()} Search Again`;
            }
        }
    }

    /**
     * Resolve URN asynchronously - fetch CivitAI info and update UI
     */
    async resolveUrnAsync(modelId, versionId, loadingElementId, modelUrl) {
        console.log('resolveUrnAsync called:', modelId, versionId);
        if (!modelId || !versionId) {
            console.log('resolveUrnAsync: missing modelId or versionId');
            return;
        }
        
        try {
            const tokens = this.getStoredTokens();
            const payload = {
                filename: modelId + '_' + versionId,
                category: '',
                is_urn: true,
                sources: ['civitai'],
                model_id: modelId,
                version_id: versionId,
                civitai_candidate_limit: tokens.civitai_candidate_limit
            };
            console.log('resolveUrnAsync payload:', JSON.stringify(payload));
            
            const response = await api.fetchApi('/model_linker/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            console.log('resolveUrnAsync response status:', response.status);
            
            if (response.ok) {
                const data = await response.json();
                const loadingEl = document.getElementById(loadingElementId);
                if (loadingEl && data.civitai) {
                    const civitai = data.civitai;
                    const label = civitai.name || civitai.filename || 'Model';
                    const url = modelUrl || `https://civitai.com/models/${modelId}?modelVersionId=${versionId}`;
                    loadingEl.innerHTML = `<a href="${url}" target="_blank" class="ml-inline-civitai-link">${label}</a>`;
                } else if (loadingEl) {
                    loadingEl.textContent = 'Not found';
                    loadingEl.style.color = 'var(--ml-text-muted)';
                }

                const downloadContainerId = loadingElementId.replace('urn-loading-', 'urn-download-');
                const downloadEl = document.getElementById(downloadContainerId);
                if (downloadEl && data.civitai) {
                    const missing = this.missingModels.find(m =>
                        `urn-download-${m.node_id}-${m.widget_index}` === downloadContainerId
                    );
                    if (missing) {
                        missing.civitai_info = {
                            model_name: data.civitai.name,
                            version_name: data.civitai.version_name,
                            expected_filename: data.civitai.filename,
                            base_model: data.civitai.base_model,
                            tags: data.civitai.tags || []
                        };
                        missing.download_source = {
                            source: 'civitai',
                            url: data.civitai.download_url,
                            filename: data.civitai.filename,
                            name: data.civitai.name,
                            type: data.civitai.type,
                            directory: missing.category || 'checkpoints',
                            match_type: 'exact',
                            size: data.civitai.size,
                            model_id: data.civitai.model_id || modelId,
                            version_id: data.civitai.version_id || versionId,
                            model_url: data.civitai.url || `https://civitai.com/models/${modelId}?modelVersionId=${versionId}`,
                            base_model: data.civitai.base_model,
                            tags: data.civitai.tags || []
                        };
                        downloadEl.outerHTML = this.renderDownloadSourceSection(missing, missing.download_source);

                        const refreshedBtn = this.contentElement?.querySelector(`#download-${missing.node_id}-${missing.widget_index}`);
                        if (refreshedBtn) {
                            refreshedBtn.addEventListener('click', () => {
                                this.downloadModel(missing);
                            });
                        }
                        if (this.contentElement) {
                            this.wireDownloadTargetAutocomplete(this.contentElement, missing);
                        }
                        this.refreshUrnLocalMatches(missing);
                    }
                } else if (downloadEl) {
                    downloadEl.innerHTML = `<div class="ml-download-info">Unable to resolve direct download for this URN.</div>`;
                }
            } else {
                const loadingEl = document.getElementById(loadingElementId);
                if (loadingEl) {
                    loadingEl.textContent = 'Error';
                    loadingEl.style.color = '#f44336';
                }
                const downloadContainerId = loadingElementId.replace('urn-loading-', 'urn-download-');
                const downloadEl = document.getElementById(downloadContainerId);
                if (downloadEl) {
                    downloadEl.innerHTML = `<div class="ml-download-info">Failed to resolve URN download.</div>`;
                }
            }
        } catch (error) {
            console.error('Model Linker: URN resolve error:', error);
            const loadingEl = document.getElementById(loadingElementId);
            if (loadingEl) {
                loadingEl.textContent = 'Error';
                loadingEl.style.color = '#f44336';
            }
            const downloadContainerId = loadingElementId.replace('urn-loading-', 'urn-download-');
            const downloadEl = document.getElementById(downloadContainerId);
            if (downloadEl) {
                downloadEl.innerHTML = `<div class="ml-download-info">Failed to resolve URN download.</div>`;
            }
        }
    }

    /**
     * Display search results
     */
    displaySearchResults(missing, state, container) {
        if (!container) return;

        const results = state?.results || {};
        const popular = results.popular;
        const modelListResult = results.model_list;
        const hfResult = results.huggingface ? (Array.isArray(results.huggingface) ? results.huggingface[0] : results.huggingface) : null;
        const civitaiResult = results.civitai ? (Array.isArray(results.civitai) ? results.civitai[0] : results.civitai) : null;
        const loraManagerArchiveResult = results.lora_manager_archive ? (Array.isArray(results.lora_manager_archive) ? results.lora_manager_archive[0] : results.lora_manager_archive) : null;
        const hasResults = popular || modelListResult || hfResult || civitaiResult || loraManagerArchiveResult;

        if (!hasResults) {
            const searchedLabel = (state?.lastAttemptSources || []).map(source => this.getSearchSourceLabel(source)).join(', ');
            container.innerHTML = this.renderStatusMessage(
                searchedLabel ? `No matches found in ${searchedLabel}.` : 'No matches found online for this model.',
                'warning'
            );
            return;
        }

        let html = '<div style="margin-top: 8px; display: flex; flex-direction: column; gap: 8px;">';

        if (state?.lastAttemptFound === false) {
            const searchedLabel = (state.lastAttemptSources || []).map(source => this.getSearchSourceLabel(source)).join(', ');
            html += this.renderStatusMessage(`No new matches found in ${searchedLabel}. Existing results are kept below.`, 'warning');
        }

        // Popular models result (highest priority)
        if (popular) {
            const popularFilename = popular.filename || missing.original_path?.split('/').pop()?.split('\\').pop() || '';
            const actionHtml = `<button class="search-download-btn ml-btn ml-btn-primary ml-btn-sm" data-url="${popular.url}" data-filename="${popularFilename}" data-category="${popular.directory || missing.category}"><span class="ml-btn-icon">☁</span> Download</button>`;
            html += this.renderOnlineSearchResultCard({
                statusClass: 'ml-status-success',
                title: 'Found in Popular Models',
                result: popular,
                filename: popularFilename,
                secondaryText: popular.name || '',
                actionHtml
            });
        }

        // Model list result (ComfyUI Manager database with fuzzy matching)
        if (modelListResult && modelListResult.url) {
            const matchType = modelListResult.match_type === 'exact' ? 'Exact match' : 'Similar model';
            const statusClass = modelListResult.match_type === 'exact' ? 'ml-status-success' : 'ml-status-info';
            const actionHtml = `<button class="search-download-btn ml-btn ml-btn-primary ml-btn-sm" data-url="${modelListResult.url}" data-filename="${modelListResult.filename}" data-category="${modelListResult.directory || missing.category}"><span class="ml-btn-icon">☁</span> Download</button>`;
            html += this.renderOnlineSearchResultCard({
                statusClass,
                title: `${matchType} in Model Database`,
                result: modelListResult,
                filename: modelListResult.filename,
                secondaryText: modelListResult.name || '',
                actionHtml
            });
        }

        // HuggingFace result
        if (hfResult && hfResult.url) {
            const hfRepo = hfResult.repo_id || hfResult.repo || '';
            const actionHtml = `<button class="search-download-btn ml-btn ml-btn-link ml-btn-sm" data-url="${hfResult.url}" data-filename="${hfResult.filename}" data-category="${missing.category}"><span class="ml-btn-icon">☁</span> Download</button>`;
            html += this.renderOnlineSearchResultCard({
                statusClass: 'ml-status-info',
                title: 'Found on HuggingFace',
                result: hfResult,
                filename: hfResult.filename,
                secondaryText: hfRepo,
                actionHtml
            });
        }

        // LoRA Manager archive result
        if (loraManagerArchiveResult && loraManagerArchiveResult.url) {
            const archiveFilename = loraManagerArchiveResult.filename || missing.original_path?.split('/').pop()?.split('\\').pop() || '';
            const actionHtml = loraManagerArchiveResult.download_url
                ? `<button class="search-download-btn ml-btn ml-btn-secondary ml-btn-sm" data-url="${loraManagerArchiveResult.download_url}" data-filename="${archiveFilename}" data-category="${missing.category}"><span class="ml-btn-icon">☁</span> Download</button>`
                : '';
            html += this.renderOnlineSearchResultCard({
                statusClass: 'ml-status-info',
                title: 'Found in LoRA Manager Archive',
                result: loraManagerArchiveResult,
                filename: archiveFilename,
                secondaryText: loraManagerArchiveResult.version_name || loraManagerArchiveResult.name || '',
                actionHtml
            });
        }

        // CivitAI result
        if (civitaiResult && civitaiResult.download_url) {
            const modelUrl = civitaiResult.url || (civitaiResult.model_id ? `https://civitai.com/models/${civitaiResult.model_id}${civitaiResult.version_id ? `?modelVersionId=${civitaiResult.version_id}` : ''}` : '');
            // Use expected_filename from URN resolution, or fallback to civitaiResult filename
            const downloadFilename = missing.civitai_info?.expected_filename || civitaiResult.filename || civitaiResult.name;
            // Build display name with version if available
            const modelName = missing.civitai_info?.version_name ? `${missing.civitai_info.model_name} v${missing.civitai_info.version_name}` : (civitaiResult.name || 'Model');
            const topLineHtml = `<div style="margin-top: 4px; font-size: 12px;"><button class="ml-btn ml-btn-sm" style="background: transparent; color: #FF9800; border: 1px solid #FF9800; font-weight: bold; cursor: pointer;" onclick="window.open('${modelUrl}', '_blank')">${modelName}</button> <span style="color: var(--ml-text-muted);">${civitaiResult.type || ''}</span></div>`;
            const actionHtml = `<button class="search-download-btn ml-btn ml-btn-sm" style="background: #FF9800;" data-url="${civitaiResult.download_url}" data-filename="${downloadFilename}" data-category="${missing.category}"><span class="ml-btn-icon">☁</span> Download</button>`;
            html += this.renderOnlineSearchResultCard({
                statusClass: 'ml-status-warning',
                title: 'Found on CivitAI',
                result: civitaiResult,
                filename: downloadFilename,
                secondaryText: '',
                topLineHtml,
                actionHtml
            });
        }

        html += '</div>';
        container.innerHTML = html;

        // Attach download listeners
        const downloadBtns = container.querySelectorAll('.search-download-btn');
        downloadBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                const filename = btn.dataset.filename;
                const category = btn.dataset.category;
                this.downloadFromSearch(missing, url, filename, category, btn);
            });
        });
    }

    /**
     * Download from search results
     */
    async downloadFromSearch(missing, url, filename, category, btn) {
        const progressId = `download-progress-${missing.node_id}-${missing.widget_index}`;
        const progressDiv = this.contentElement?.querySelector(`#${progressId}`);
        const tokens = this.getStoredTokens();
        const targetSelection = this.getDownloadTargetSelection(missing, category || missing.category || 'checkpoints');

        try {
            btn.disabled = true;
            btn.textContent = 'Starting...';
            
            if (progressDiv) {
                progressDiv.style.display = 'block';
                // Show progress bar with cancel button immediately
                progressDiv.innerHTML = `
                    <div class="ml-progress-container">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div class="ml-progress-bar" style="flex: 1;">
                                <div class="ml-progress-fill" style="width: 0%;"></div>
                            </div>
                            <button class="cancel-download-btn-pending ml-btn ml-btn-danger ml-btn-sm">
                                Cancel
                            </button>
                        </div>
                        <div class="ml-progress-text">
                            <span style="color: #2196F3;">Connecting...</span>
                        </div>
                    </div>
                `;
            }

            const response = await api.fetchApi('/model_linker/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    filename,
                    category: targetSelection.category,
                    subfolder: targetSelection.subfolder,
                    hf_token: tokens.hf_token,
                    civitai_key: tokens.civitai_key
                })
            });

            if (!response.ok) {
                throw new Error(`Download failed: ${response.status}`);
            }

            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'Download failed');
            }

            // Track and poll
            const downloadId = data.download_id;
            this.activeDownloads[downloadId] = { missing, progressDiv, downloadBtn: btn };
            
            // Update the Download All button state
            this.updateDownloadAllButtonState();
            
            // Attach cancel handler to pending button (before polling replaces it)
            const pendingCancelBtn = progressDiv?.querySelector('.cancel-download-btn-pending');
            if (pendingCancelBtn) {
                pendingCancelBtn.addEventListener('click', () => this.cancelDownload(downloadId));
            }
            
            this.pollDownloadProgress(downloadId);

        } catch (error) {
            console.error('Model Linker: Download error:', error);
            if (progressDiv) {
                progressDiv.innerHTML = this.renderStatusMessage(error.message, 'error');
            }
            btn.disabled = false;
            btn.textContent = 'Retry';
            this.showNotification('Download failed: ' + error.message, 'error');
        }
    }

    /**
     * Format bytes to human readable string
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    /**
     * Extract model card URL from a download URL
     * HuggingFace: https://huggingface.co/Owner/Repo/resolve/main/file.safetensors -> https://huggingface.co/Owner/Repo
     * CivitAI: https://civitai.com/api/download/models/123?type=Model -> https://civitai.com/models/123
     */
    getModelCardUrl(downloadUrl) {
        if (!downloadUrl) return null;
        
        try {
            // HuggingFace URLs
            if (downloadUrl.includes('huggingface.co')) {
                // Extract owner/repo from URL
                const match = downloadUrl.match(/huggingface\.co\/([^\/]+\/[^\/]+)/);
                if (match) {
                    return `https://huggingface.co/${match[1]}`;
                }
            }
            
            // CivitAI URLs
            if (downloadUrl.includes('civitai.com')) {
                // Format: /api/download/models/123456 or /models/123456/...
                const modelIdMatch = downloadUrl.match(/models\/(\d+)/);
                if (modelIdMatch) {
                    return `https://civitai.com/models/${modelIdMatch[1]}`;
                }
            }
        } catch (e) {
            console.error('Error parsing model card URL:', e);
        }
        
        return null;
    }

    /**
     * Update workflow in ComfyUI's UI/memory
     * Updates the current workflow in place instead of creating a new tab
     */
    async updateWorkflowInComfyUI(workflow) {
        if (!app || !app.graph) {
            console.warn('Model Linker: Could not update workflow - app or app.graph not available');
            return;
        }

        try {
            // Method 1: Try to directly update the current graph using configure
            // This is the most direct way to update in place
            if (app.graph && typeof app.graph.configure === 'function') {
                app.graph.configure(workflow);
                return;
            }

            // Method 2: Try deserialize to update the graph in place
            if (app.graph && typeof app.graph.deserialize === 'function') {
                app.graph.deserialize(workflow);
                return;
            }

            // Method 3: Use loadGraphData with explicit parameters to update current tab
            // The key is to NOT create a new workflow - pass null or undefined for the workflow parameter
            // clean=false means don't clear the graph first
            // restore_view=false means don't restore the viewport
            // workflow=null means update current workflow instead of creating new one
            if (app.loadGraphData) {
                // Try with null as 4th parameter first
                await app.loadGraphData(workflow, false, false, null);
                return;
            }

            console.warn('Model Linker: No method available to update workflow');
        } catch (error) {
            console.error('Model Linker: Error updating workflow in ComfyUI:', error);
            // Don't throw - allow the workflow update to continue even if UI update fails
            // The backend has already updated the workflow data
        }
    }
}

// Main extension class
class ModelLinker {
    constructor() {
        this.linkerButton = null;
        this.buttonGroup = null;
        this.buttonId = "model-linker-button";
        this.dialog = null;
        this.isCheckingMissing = false;  // Prevent multiple simultaneous checks
        this.lastCheckedWorkflow = null;  // Track to avoid duplicate checks
    }

    setup = async () => {
        // Remove any existing button
        this.removeExistingButton();

        // Create dialog instance
        if (!this.dialog) {
            this.dialog = new LinkerManagerDialog();
            window.modelLinkerDialog = this.dialog;
        }

        // Register keyboard shortcut (Ctrl+Shift+L)
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
                e.preventDefault();
                this.openLinkerManager();
            }
        });

        // Listen for workflow load events to auto-check for missing models
        this.setupAutoOpenOnMissingModels();

        // Try to use new ComfyUI button system (like ComfyUI Manager does)
        try {
            // Dynamic imports for ComfyUI's button components
            const { ComfyButtonGroup } = await import("../../../scripts/ui/components/buttonGroup.js");
            const { ComfyButton } = await import("../../../scripts/ui/components/button.js");

            // Create button group with Model Linker button
            this.buttonGroup = new ComfyButtonGroup(
                new ComfyButton({
                    icon: "link-variant",
                    action: () => this.openLinkerManager(),
                    tooltip: "Model Linker - Resolve missing models (Ctrl+Shift+L)",
                    content: "Model Linker",
                    classList: "comfyui-button comfyui-menu-mobile-collapse"
                }).element
            );

            // Insert before settings group in the menu
            app.menu?.settingsGroup.element.before(this.buttonGroup.element);
        } catch (e) {
            // Fallback for older ComfyUI versions without the new button system
            console.log('Model Linker: New button system not available, using floating button fallback.');
            this.createFloatingButton();
        }
    }

    /**
     * Setup auto-open functionality when workflow is loaded with missing models
     */
    setupAutoOpenOnMissingModels() {
        // Watch for ComfyUI's Missing Models popup and inject our button
        this.setupMissingModelsPopupObserver();

        console.log('Model Linker: Missing models popup button injection enabled');
    }

    /**
     * Setup MutationObserver to detect ComfyUI's Missing Models popup and inject our button
     */
    setupMissingModelsPopupObserver() {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        this.checkAndInjectButton(node);
                    }
                }
            }
        });

        // Observe the entire document for added nodes
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    /**
     * Check if a node is the Missing Models popup and inject our buttons
     */
    checkAndInjectButton(node) {
        // Look for the Missing Models popup by finding elements with "Missing Models" text
        const findMissingModelsDialog = (element) => {
            // Check if this element or its children contain "Missing Models" heading
            const headings = element.querySelectorAll ? element.querySelectorAll('h2, h3, [class*="title"], [class*="header"]') : [];
            for (const heading of headings) {
                if (heading.textContent?.includes('Missing Models')) {
                    return element;
                }
            }
            // Also check text content directly
            if (element.textContent?.includes('Missing Models') && 
                element.textContent?.includes('following models were not found')) {
                return element;
            }
            return null;
        };

        const dialog = findMissingModelsDialog(node);
        if (!dialog) return;

        // Check if we already injected buttons
        if (dialog.querySelector('#model-linker-btn-container')) return;

        // Find a suitable place to inject the button
        const injectButtons = () => {
            // Common button style
            const btnStyle = `
                padding: 6px 12px;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                transition: all 0.2s ease;
                white-space: nowrap;
            `;

            // Auto-resolve button (green)
            const autoResolveBtn = document.createElement('button');
            autoResolveBtn.id = 'model-linker-btn-container'; // Use this ID to prevent duplicate injection
            autoResolveBtn.textContent = '🔗 Auto-resolve 100%';
            autoResolveBtn.title = 'Automatically link models with 100% confidence matches';
            autoResolveBtn.style.cssText = btnStyle + `background: #4CAF50;`;
            
            autoResolveBtn.addEventListener('mouseenter', () => {
                autoResolveBtn.style.background = '#45a049';
            });
            autoResolveBtn.addEventListener('mouseleave', () => {
                autoResolveBtn.style.background = '#4CAF50';
            });
            autoResolveBtn.addEventListener('click', async () => {
                await this.handleAutoResolveInPopup(dialog, autoResolveBtn);
            });

            // Find the "Don't show this again" checkbox row and add button next to it
            const checkbox = dialog.querySelector('input[type="checkbox"]');
            if (checkbox) {
                const checkboxRow = checkbox.closest('label') || checkbox.parentElement;
                if (checkboxRow && checkboxRow.parentElement) {
                    // Make the parent a flex container to align checkbox and button
                    checkboxRow.parentElement.style.cssText = `
                        display: flex;
                        align-items: center;
                        gap: 16px;
                        padding: 0 16px;
                        margin-bottom: 8px;
                    `;
                    // Insert button at the beginning (left side)
                    checkboxRow.parentElement.insertBefore(autoResolveBtn, checkboxRow);
                    return;
                }
            }

            // Fallback: Find the list of models and insert before it
            const modelList = dialog.querySelector('[style*="overflow"]') || 
                             dialog.querySelector('[class*="list"]') ||
                             dialog.querySelector('[class*="content"]');
            
            if (modelList) {
                // Create a wrapper and insert before the model list
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'display: flex; justify-content: flex-end; padding: 0 16px; margin-bottom: 8px;';
                wrapper.appendChild(autoResolveBtn);
                modelList.parentElement?.insertBefore(wrapper, modelList);
            } else {
                // Find after the description text
                const allElements = dialog.querySelectorAll('*');
                for (const el of allElements) {
                    if (el.textContent?.includes('following models were not found') && 
                        el.children.length === 0) {
                        el.parentElement?.insertBefore(btnContainer, el.nextSibling);
                        break;
                    }
                }
            }
            
            console.log('Model Linker: Injected buttons into Missing Models popup');
        };

        // Small delay to ensure popup is fully rendered
        setTimeout(injectButtons, 100);
    }

    /**
     * Handle auto-resolve in the popup - resolve 100% matches and open Model Linker for remaining
     */
    async handleAutoResolveInPopup(dialog, button) {
        button.textContent = '⏳ Resolving...';
        button.disabled = true;

        // Close the popup first
        const closeBtn = dialog.querySelector('button[class*="close"]') || 
                        dialog.querySelector('svg')?.closest('button') ||
                        Array.from(dialog.querySelectorAll('button')).find(b => 
                            b.textContent === '×' || b.innerHTML.includes('×') || b.innerHTML.includes('close'));
        
        if (closeBtn) {
            closeBtn.click();
        }

        // Small delay to let popup close
        await new Promise(r => setTimeout(r, 200));

// Create dialog if needed
        if (!this.dialog) {
            this.dialog = new LinkerManagerDialog();
            window.modelLinkerDialog = this.dialog;
        }
        
        // Run auto-resolve for 100% matches - returns the updated workflow
        const updatedWorkflow = await this.dialog.autoResolve100Percent();
        
        // Always open Model Linker to show remaining unresolved models
        // Pass the updated workflow if available to avoid race condition
        this.dialog.show(updatedWorkflow || null);
    }

    /**
     * Mark resolved model items in the popup as linked (green) and hide download buttons
     */
    removeResolvedFromPopup(dialog, resolvedFilenames) {
        console.log('Model Linker: Looking for resolved filenames:', resolvedFilenames);
        
        // Strategy: For each filename, find text nodes containing it, 
        // then find the nearest Download button and mark that row
        for (const filename of resolvedFilenames) {
            // Get all text in the dialog and find elements containing our filename
            const walker = document.createTreeWalker(
                dialog,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            let node;
            while (node = walker.nextNode()) {
                if (node.textContent?.toLowerCase().includes(filename)) {
                    // Found text containing filename - now find parent with Download button
                    let parent = node.parentElement;
                    let attempts = 0;
                    
                    while (parent && parent !== dialog && attempts < 10) {
                        // Look for Download button at this level
                        const downloadBtn = Array.from(parent.querySelectorAll('button'))
                            .find(btn => btn.textContent?.includes('Download') && 
                                        !btn.id?.includes('model-linker'));
                        
                        if (downloadBtn) {
                            console.log('Model Linker: Found entry for', filename);
                            this.markEntryAsResolved(parent, downloadBtn);
                            break;
                        }
                        
                        parent = parent.parentElement;
                        attempts++;
                    }
                    
                    // Only process first match for this filename
                    break;
                }
            }
        }
    }

    /**
     * Mark a model entry as resolved with visual feedback
     */
    markEntryAsResolved(container, downloadBtn) {
        // Already marked?
        if (container.dataset.resolved === 'true') return;
        container.dataset.resolved = 'true';
        
        console.log('Model Linker: Marking entry as resolved', container);
        
        // Add green background/styling to the container
        container.style.transition = 'all 0.3s ease';
        container.style.background = 'rgba(76, 175, 80, 0.2)';
        container.style.borderRadius = '6px';
        container.style.border = '1px solid #4CAF50';
        
        // Hide the Download button and replace with badge
        if (downloadBtn) {
            // Create badge
            const badge = document.createElement('span');
            badge.textContent = '✓ Linked';
            badge.style.cssText = `
                display: inline-flex;
                align-items: center;
                padding: 4px 12px;
                background: #4CAF50;
                color: white;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 600;
            `;
            
            // Replace download button with badge
            downloadBtn.style.display = 'none';
            downloadBtn.parentElement?.insertBefore(badge, downloadBtn);
        }
        
        // Find and hide Copy URL button
        const allBtns = container.querySelectorAll('button');
        for (const btn of allBtns) {
            if (btn.textContent?.includes('Copy URL')) {
                btn.style.display = 'none';
            }
        }
    }

    /**
     * Count remaining model items in the popup
     */
    countRemainingItems(dialog) {
        // Count elements that look like model entries (have Download buttons)
        const downloadButtons = dialog.querySelectorAll('button');
        let count = 0;
        for (const btn of downloadButtons) {
            if (btn.textContent?.includes('Download') && !btn.id?.includes('model-linker')) {
                count++;
            }
        }
        return count;
    }

    /**
     * Update nodes directly in the graph without triggering a full workflow reload
     * This prevents the Missing Models popup from closing
     */
    updateNodesDirectly(resolutions) {
        if (!app?.graph) {
            console.warn('Model Linker: Cannot update nodes - graph not available');
            return;
        }

        for (const resolution of resolutions) {
            const nodeId = resolution.node_id;
            const widgetIndex = resolution.widget_index;
            const resolvedPath = resolution.resolved_path;

            // Find the node in the graph
            const node = app.graph.getNodeById(nodeId);
            if (!node) {
                console.warn(`Model Linker: Node ${nodeId} not found in graph`);
                continue;
            }

            // Update the widget value
            if (node.widgets && node.widgets[widgetIndex]) {
                const widget = node.widgets[widgetIndex];
                widget.value = resolvedPath;
                
                // Trigger widget callback if it exists
                if (widget.callback) {
                    widget.callback(resolvedPath, app.graph, node, null, null);
                }
                
                console.log(`Model Linker: Updated node ${nodeId} widget ${widgetIndex} to ${resolvedPath}`);
            } else if (node.widgets_values) {
                // Fallback: update widgets_values array directly
                node.widgets_values[widgetIndex] = resolvedPath;
                console.log(`Model Linker: Updated node ${nodeId} widgets_values[${widgetIndex}] to ${resolvedPath}`);
            }

            // Mark node as dirty to trigger redraw
            if (node.setDirtyCanvas) {
                node.setDirtyCanvas(true, true);
            }
        }

        // Trigger canvas redraw
        if (app.graph.setDirtyCanvas) {
            app.graph.setDirtyCanvas(true, true);
        }
    }

    /**
     * Check if auto-open is enabled in user settings
     */
    isAutoOpenEnabled() {
        return localStorage.getItem('modelLinker.autoOpenOnMissing') !== 'false';
    }

    /**
     * Set auto-open preference
     */
    setAutoOpenEnabled(enabled) {
        localStorage.setItem('modelLinker.autoOpenOnMissing', enabled ? 'true' : 'false');
    }

    /**
     * Check for missing models and auto-open dialog if any are found
     */
    async checkAndOpenForMissingModels() {
        // Check if auto-open is enabled
        if (!this.isAutoOpenEnabled()) {
            return;
        }

        // Prevent multiple simultaneous checks
        if (this.isCheckingMissing) {
            return;
        }

        this.isCheckingMissing = true;

        try {
            // Small delay to let workflow fully load
            await new Promise(r => setTimeout(r, 500));

            // Get current workflow
            const workflow = app?.graph?.serialize();
            if (!workflow) {
                return;
            }

            // Create a simple hash to detect if workflow changed
            const workflowHash = JSON.stringify(workflow.nodes?.map(n => n.type + ':' + JSON.stringify(n.widgets_values || [])));
            
            // Skip if we already checked this exact workflow
            if (this.lastCheckedWorkflow === workflowHash) {
                return;
            }
            this.lastCheckedWorkflow = workflowHash;

            // Call analyze endpoint to check for missing models
            const response = await api.fetchApi('/model_linker/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflow })
            });

            if (!response.ok) {
                console.warn('Model Linker: Failed to analyze workflow for missing models');
                return;
            }

            const data = await response.json();
            
            // Auto-open dialog if there are missing models
            if (data.total_missing > 0) {
                console.log(`Model Linker: Found ${data.total_missing} missing model(s), opening dialog...`);
                this.openLinkerManager();
            }

        } catch (error) {
            console.error('Model Linker: Error checking for missing models:', error);
        } finally {
            this.isCheckingMissing = false;
        }
    }

    removeExistingButton() {
        // Remove any existing button by ID
        const existingButton = document.getElementById(this.buttonId);
        if (existingButton) {
            existingButton.remove();
        }

        // Remove button group if it exists
        if (this.buttonGroup?.element?.parentNode) {
            this.buttonGroup.element.remove();
            this.buttonGroup = null;
        }

        // Also remove the stored reference if it exists
        if (this.linkerButton && this.linkerButton.parentNode) {
            this.linkerButton.remove();
            this.linkerButton = null;
        }
    }

    createFloatingButton() {
        // Create a floating button as fallback for legacy ComfyUI versions
        this.linkerButton = $el("button", {
            id: this.buttonId,
            textContent: "🔗 Model Linker",
            title: "Open Model Linker to resolve missing models (Ctrl+Shift+L)",
            onclick: () => {
                this.openLinkerManager();
            },
            style: {
                position: "fixed",
                top: "10px",
                right: "10px",
                zIndex: "10000",
                backgroundColor: "var(--comfy-input-bg, #353535)",
                color: "var(--input-text, #ffffff)",
                border: "2px solid var(--primary-color, #007acc)",
                padding: "8px 16px",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "600",
                boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                transition: "all 0.2s ease",
                whiteSpace: "nowrap"
            }
        });

        // Add hover effects
        this.linkerButton.addEventListener("mouseenter", () => {
            this.linkerButton.style.backgroundColor = "var(--primary-color, #007acc)";
            this.linkerButton.style.transform = "scale(1.05)";
        });

        this.linkerButton.addEventListener("mouseleave", () => {
            this.linkerButton.style.backgroundColor = "var(--comfy-input-bg, #353535)";
            this.linkerButton.style.transform = "scale(1)";
        });

        document.body.appendChild(this.linkerButton);
    }

    openLinkerManager() {
        try {
            if (!this.dialog) {
                this.dialog = new LinkerManagerDialog();
                window.modelLinkerDialog = this.dialog;
            }
            this.dialog.show();
        } catch (error) {
            console.error("🔗 Model Linker: Error creating/showing dialog:", error);
            alert("Error opening Model Linker: " + error.message);
        }
    }

    static switchFilter(filter) {
        document.querySelectorAll('.ml-btn-filter').forEach(b => b.classList.remove('active'));
        document.getElementById('filter-' + filter).classList.add('active');
        
        document.querySelectorAll('.ml-model-section').forEach(s => {
            const hasActive = s.dataset.mlActive === 'true';
            const hasInactive = s.dataset.mlInactive === 'true';
            
            if (filter === 'all') {
                s.style.display = 'block';
            } else if (filter === 'active') {
                s.style.display = hasActive ? 'block' : 'none';
            } else if (filter === 'inactive') {
                s.style.display = hasInactive ? 'block' : 'none';
            }
        });
        
        const copySection = document.querySelector('[id^="ml-copy-"]');
        if (copySection) {
            const codeEl = copySection.querySelector('code');
            const labelEl = copySection.querySelector('div');
            
            if (filter === 'all') {
                codeEl.textContent = copySection.dataset.mlAll;
                labelEl.textContent = 'Copy all:';
            } else if (filter === 'active') {
                codeEl.textContent = copySection.dataset.mlActive;
                labelEl.textContent = 'Copy active:';
            } else if (filter === 'inactive') {
                codeEl.textContent = copySection.dataset.mlInactive;
                labelEl.textContent = 'Copy inactive:';
            }
        }
    }

    static copyToClipboard(text, btn) {
        navigator.clipboard.writeText(text).then(() => {
            const orig = btn.textContent;
            btn.textContent = '✓';
            setTimeout(() => btn.textContent = orig, 1500);
        });
    }

    static copyFromCode(sectionId, btn) {
        const section = document.getElementById(sectionId);
        const codeEl = section.querySelector('code');
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
            const orig = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => btn.textContent = orig, 1500);
        });
    }
}

const modelLinker = new ModelLinker();

// Register the extension
app.registerExtension({
    name: "Model Linker",
    setup: modelLinker.setup
});

// Global helper functions for inline onclick handlers
window.MLFilterSwitch = function(filter) {
    const filterBtn = document.getElementById('filter-' + filter);
    if (!filterBtn) return;
    
    // Update button states
    document.querySelectorAll('.ml-btn-filter').forEach(b => b.classList.remove('active'));
    filterBtn.classList.add('active');
    
    // Filter model sections
    document.querySelectorAll('.ml-model-section').forEach(s => {
        const hasActive = s.getAttribute('data-ml-active') === 'true';
        const hasInactive = s.getAttribute('data-ml-inactive') === 'true';
        
        // Get child divs: category header, active section, inactive section
        const childDivs = Array.from(s.children).filter(c => c.tagName === 'DIV');
        const activeSection = childDivs[1];
        const inactiveSection = childDivs[2];
        
        if (filter === 'all') {
            s.style.display = 'block';
            if (activeSection) activeSection.style.display = 'block';
            if (inactiveSection) inactiveSection.style.display = 'block';
        } else if (filter === 'active') {
            s.style.display = hasActive ? 'block' : 'none';
            if (activeSection) activeSection.style.display = hasActive ? 'block' : 'none';
            if (inactiveSection) inactiveSection.style.display = 'none';
        } else if (filter === 'inactive') {
            s.style.display = hasInactive ? 'block' : 'none';
            if (activeSection) activeSection.style.display = 'none';
            if (inactiveSection) inactiveSection.style.display = hasInactive ? 'block' : 'none';
        }
    });
    
    const copySection = document.querySelector('[id^="ml-copy-"]');
    if (copySection) {
        const codeEl = copySection.querySelector('code');
        const labelEl = copySection.querySelector('div');
        
        if (filter === 'all') {
            codeEl.textContent = copySection.dataset.mlAll;
            labelEl.textContent = 'Copy all:';
        } else if (filter === 'active') {
            codeEl.textContent = copySection.dataset.mlActive;
            labelEl.textContent = 'Copy active:';
        } else if (filter === 'inactive') {
            codeEl.textContent = copySection.dataset.mlInactive;
            labelEl.textContent = 'Copy inactive:';
        }
    }
};

window.MLCopy = function(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => btn.textContent = orig, 1500);
    });
};

window.MLCopyCode = function(sectionId, btn) {
    const section = document.getElementById(sectionId);
    const codeEl = section.querySelector('code');
    navigator.clipboard.writeText(codeEl.textContent).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
    });
};

window.MLOpenContextMenu = function(event, element) {
    event.preventDefault();
    event.stopPropagation();
    
    try {
        const modelData = element.getAttribute('data-model');
        if (!modelData) return;
        
        const model = JSON.parse(decodeURIComponent(modelData));
        
        // Get dialog instance
        const dialog = window.modelLinkerDialog;
        if (dialog && dialog.showContextMenu) {
            dialog.showContextMenu(event.clientX, event.clientY, model);
        }
    } catch (e) {
        console.error('Model Linker: Error opening context menu:', e);
    }
};

