// 文件名: content.js
// v2.6.2 (优化: YouTube字幕翻译通过智能分句提升上下文准确性)

let settings = {
    engine: 'google',
    targetLanguage: 'zh-CN',
    geminiApiKey: '',
    debugMode: false,
};
let translationCache = new Map();
const DEBUG_PREFIX = "[翻译插件调试]";

// --- 初始化和设置加载 ---
(async () => {
    try {
        const storedSettings = await chrome.storage.sync.get(Object.keys(settings));
        settings = { ...settings, ...storedSettings };
        const storedCache = await chrome.storage.local.get(['translationCache']);
        if (storedCache.translationCache) {
            translationCache = new Map(Object.entries(storedCache.translationCache));
        }
        if (settings.debugMode) console.log(DEBUG_PREFIX, "初始化成功, 当前设置:", settings);

        // 初始化YouTube功能
        initYouTubeSubtitleFeature();
    } catch (e) {
        console.error(DEBUG_PREFIX, "初始化失败:", e);
    }
})();

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
        for (let key in changes) {
            settings[key] = changes[key].newValue;
        }
        if (settings.debugMode) console.log(DEBUG_PREFIX, "设置已更新:", settings);
    }
    if (changes.engine || changes.targetLanguage) {
        translationCache.clear();
        youtubeSubtitleCache.clear(); // 同时清除YouTube字幕缓存
        if (settings.debugMode) console.log(DEBUG_PREFIX, "引擎或语言变更, 缓存已清除。");
    }
});

// --- 核心消息监听器 ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "youtubeSubtitleUrlReady") {
        enableYoutubeTranslateButton();
        sendResponse({status: "ok"});
        return true;
    }

    if (request.action === "translate") {
        if (settings.engine === 'gemini' && !settings.geminiApiKey) {
            showNotification(`请先设置您的 Gemini API 密钥。`);
            sendResponse({status: "error", message: "Gemini API key not set"});
            return true;
        }
        if (settings.debugMode) console.log(DEBUG_PREFIX, "开始整页翻译, 引擎:", settings.engine);
        translatePageByParagraphs(document.body);
        startObservers();
        chrome.runtime.sendMessage({ action: 'updateTranslationState', isTranslated: true });
        sendResponse({status: "ok"});

    } else if (request.action === "restore") {
        if (settings.debugMode) console.log(DEBUG_PREFIX, "开始还原页面。");
        stopObservers();
        restoreOriginalContent();
        chrome.runtime.sendMessage({ action: 'updateTranslationState', isTranslated: false });
        sendResponse({status: "ok"});

    } else if (request.action === "clearCache") {
        translationCache.clear();
        youtubeSubtitleCache.clear();
        if (settings.debugMode) console.log(DEBUG_PREFIX, "收到清除缓存指令。");
        sendResponse({status: "缓存已清除"});
    }
    return true;
});


// --- 划词翻译功能 (保持不变) ---
let selectionPopup = null;
document.addEventListener('mouseup', (e) => {
    if (e.target.closest && (e.target.closest('.custom-translator-popup') || e.target.closest('.custom-translator-button'))) { return; }
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
        removeSelectionPopup();
        return;
    }
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();
    if (selectedText.length > 0 && selectedText.length < 1000) {
        if (settings.debugMode) console.log(DEBUG_PREFIX, "检测到文本选择:", selectedText);
        createTranslationPopup(selection.getRangeAt(0), selectedText);
    } else {
        removeSelectionPopup();
    }
});
document.addEventListener('mousedown', (e) => {
    if (selectionPopup && (!e.target.closest || !e.target.closest('.custom-translator-popup'))) {
        removeSelectionPopup();
    }
});
function removeSelectionPopup() {
    if (selectionPopup) {
        selectionPopup.remove();
        selectionPopup = null;
    }
}
function createTranslationPopup(range, text) {
    removeSelectionPopup();
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (settings.debugMode) console.log(DEBUG_PREFIX, "创建划词翻译弹窗。");
    selectionPopup = document.createElement('div');
    selectionPopup.className = 'custom-translator-popup';
    selectionPopup.style.setProperty('--popup-top', `${rect.bottom + window.scrollY + 5}px`);
    selectionPopup.style.setProperty('--popup-left', `${rect.left + window.scrollX}px`);
    const button = document.createElement('button');
    button.className = 'custom-translator-button';
    button.textContent = '翻译';
    selectionPopup.appendChild(button);
    document.body.appendChild(selectionPopup);
    button.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (selectionPopup) {
            selectionPopup.innerHTML = '<div class="loader"></div>';
            try {
                if (settings.engine === 'gemini' && !settings.geminiApiKey) {
                    throw new Error("请先设置您的 Gemini API 密钥。");
                }
                const translatedText = await translateSingleText(text);
                if (selectionPopup) {
                    selectionPopup.innerHTML = `<div class="translated-content">${translatedText}</div>`;
                }
            } catch (error) {
                 if (selectionPopup) {
                    selectionPopup.innerHTML = `<div class="translated-content">翻译出错: ${error.message}</div>`;
                 }
                 console.error("划词翻译出错:", error);
            }
        }
    });
}


// --- 监视器定义 (保持不变) ---
const pageObserver = new MutationObserver((mutationsList) => {
    const rootsToProcess = new Set();
    for (const mutation of mutationsList) {
        if (mutation.target.nodeType !== Node.ELEMENT_NODE) {
            if (mutation.type === 'characterData' && mutation.target.parentElement) {
                 if(mutation.target.parentElement.closest('.custom-translator-popup, .custom-translator-notification, .translated-text')) continue;
                 rootsToProcess.add(mutation.target.parentElement);
            }
            continue;
        }
        if (mutation.target.closest('.custom-translator-popup, .custom-translator-notification, .translated-text')) {
            continue;
        }
        if (mutation.target.dataset?.isTranslated || mutation.target.closest('[data-is-translated="true"]')) {
            continue;
        }
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType !== Node.ELEMENT_NODE || node.closest('.custom-translator-popup, .custom-translator-notification, .translated-text')) {
                    return;
                }
                rootsToProcess.add(node);
            });
        }
    }
    if (rootsToProcess.size > 0) {
        if (settings.debugMode) console.log(DEBUG_PREFIX, "检测到动态内容, 准备翻译:", rootsToProcess);
        rootsToProcess.forEach(root => translatePageByParagraphs(root));
    }
});

function startObservers() {
    pageObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });
    if (settings.debugMode) console.log(DEBUG_PREFIX, "页面动态内容监控已启动。");
}

function stopObservers() {
    pageObserver.disconnect();
    if (settings.debugMode) console.log(DEBUG_PREFIX, "页面动态内容监控已停止。");
}


// --- YOUTUBE 字幕翻译新功能 ---

let youtubeSubtitleCache = new Map();
let isYoutubeTranslationActive = false;
let youtubeObserver = null;
let translateButton = null;

function initYouTubeSubtitleFeature() {
    if (window.location.hostname.includes("youtube.com") && window.location.pathname.includes("watch")) {
        if (settings.debugMode) console.log(DEBUG_PREFIX, "YouTube 观看页面已检测到，启动字幕翻译功能。");
        const playerObserver = new MutationObserver((mutations, obs) => {
            const controls = document.querySelector('.ytp-right-controls');
            if (controls && !document.querySelector('.yt-translate-button')) {
                injectTranslateButton(controls);
                obs.disconnect();
            }
        });
        playerObserver.observe(document.body, { childList: true, subtree: true });
    }
}

function injectTranslateButton(controls) {
    translateButton = document.createElement('button');
    translateButton.className = 'ytp-button yt-translate-button';
    translateButton.title = '翻译字幕 (等待字幕加载)';
    translateButton.disabled = true;
    translateButton.innerHTML = `<svg class="yt-translate-icon" viewBox="0 0 24 24"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4.86 19l5.09-5.02.03.03 5.09 5.02 1.41-1.41-2.54-2.51zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"></path></svg>`;
    translateButton.addEventListener('click', handleYoutubeTranslateClick);
    controls.prepend(translateButton);
}

function enableYoutubeTranslateButton() {
    if (translateButton) {
        translateButton.disabled = false;
        translateButton.title = '翻译字幕';
    }
}

async function handleYoutubeTranslateClick() {
    isYoutubeTranslationActive = !isYoutubeTranslationActive;
    translateButton.classList.toggle('active', isYoutubeTranslationActive);
    translateButton.title = isYoutubeTranslationActive ? '关闭字幕翻译' : '翻译字幕';

    const playerContainer = document.getElementById('movie_player');
    if (playerContainer) {
        playerContainer.classList.toggle('youtube-translation-active', isYoutubeTranslationActive);
    }

    if (isYoutubeTranslationActive) {
        if (youtubeSubtitleCache.size > 0) {
            startYoutubeSubtitleObserver();
        } else {
            const { url } = await chrome.runtime.sendMessage({ action: 'getYoutubeSubtitleUrl' });
            if (url) {
                showNotification("开始预翻译字幕，请稍候...");
                await fetchAndProcessSubtitles(url);
                startYoutubeSubtitleObserver();
            } else {
                showNotification("错误：未找到字幕文件。请先在视频中开启英文字幕。");
                isYoutubeTranslationActive = false;
                translateButton.classList.remove('active');
                 if (playerContainer) playerContainer.classList.remove('youtube-translation-active');
            }
        }
    } else {
        stopYoutubeSubtitleObserver();
    }
}

async function fetchAndProcessSubtitles(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();

        if (!data.events || data.events.length === 0) {
            showNotification("字幕文件为空或格式不正确。");
            return;
        }

        // 1. 智能聚合为句子
        const sentenceGroups = [];
        let currentSentence = "";
        let currentSegments = [];

        for (const event of data.events) {
            if (event.segs) {
                const textSegment = event.segs.map(seg => seg.utf8).join('').trim();

                // YouTube 使用一个简单的换行段来分隔句子/意图
                if (textSegment === "") {
                    if (currentSentence.trim()) {
                        sentenceGroups.push({
                            originalSentence: currentSentence.trim(),
                            segments: [...currentSegments]
                        });
                    }
                    currentSentence = "";
                    currentSegments = [];
                } else {
                    const cleanedSegment = textSegment.replace(/\n/g, ' ').trim();
                    if (cleanedSegment) {
                        currentSentence += cleanedSegment + " ";
                        currentSegments.push(cleanedSegment);
                    }
                }
            }
        }
        // 添加最后一个句子（如果存在）
        if (currentSentence.trim()) {
            sentenceGroups.push({
                originalSentence: currentSentence.trim(),
                segments: [...currentSegments]
            });
        }

        if (sentenceGroups.length === 0) {
            showNotification("未在字幕文件中找到有效文本。");
            return;
        }

        const sentencesToTranslate = sentenceGroups.map(g => g.originalSentence);

        // 2. 分块翻译句子
        const CHUNK_SIZE = settings.engine === 'gemini' ? 50 : 10;
        let allTranslatedSentences = [];

        for (let i = 0; i < sentencesToTranslate.length; i += CHUNK_SIZE) {
            const chunk = sentencesToTranslate.slice(i, i + CHUNK_SIZE);
            const translatedChunk = await translateChunk(chunk);
            if (translatedChunk && translatedChunk.length === chunk.length) {
                 allTranslatedSentences.push(...translatedChunk);
            } else {
                console.error(DEBUG_PREFIX, "一个字幕块翻译失败。", translatedChunk);
                allTranslatedSentences.push(...chunk.map(() => "[翻译失败]"));
            }
            await new Promise(resolve => setTimeout(resolve, 1100)); // API 礼貌性延迟
        }

        // 3. 构建新的缓存
        if (sentenceGroups.length === allTranslatedSentences.length) {
            sentenceGroups.forEach((group, index) => {
                const translatedSentence = allTranslatedSentences[index];
                group.segments.forEach(segment => {
                    youtubeSubtitleCache.set(segment, translatedSentence);
                });
            });
            showNotification("字幕翻译完成！");
            if (settings.debugMode) console.log(DEBUG_PREFIX, `YouTube字幕缓存已构建，共 ${youtubeSubtitleCache.size} 条。`);
        } else {
            console.error(DEBUG_PREFIX, "翻译结果数量与原文数量不匹配。");
            showNotification("字幕翻译出错：结果不匹配。");
        }

    } catch (error) {
        console.error("处理YouTube字幕失败:", error);
        showNotification(`字幕翻译失败: ${error.message}`);
    }
}


function startYoutubeSubtitleObserver() {
    if (youtubeObserver) youtubeObserver.disconnect();
    const captionWindow = document.querySelector('.ytp-caption-window-container');
    if (!captionWindow) {
        if (settings.debugMode) console.log(DEBUG_PREFIX, "找不到YouTube字幕容器。");
        return;
    }

    youtubeObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('ytp-caption-segment')) {
                    const originalText = node.innerText.replace(/\n/g, ' ').trim();
                    if (youtubeSubtitleCache.has(originalText)) {
                        const translatedText = youtubeSubtitleCache.get(originalText);

                        if (!node.dataset.originalText) {
                            node.dataset.originalText = node.innerText;
                        }
                        node.innerText = translatedText;
                        node.dataset.ytTranslated = 'true';
                    }
                }
            });
        }
    });

    youtubeObserver.observe(captionWindow, { childList: true, subtree: true });
    if (settings.debugMode) console.log(DEBUG_PREFIX, "YouTube字幕翻译监控已启动。");
}

function stopYoutubeSubtitleObserver() {
    if (youtubeObserver) {
        youtubeObserver.disconnect();
        youtubeObserver = null;

        document.querySelectorAll('[data-yt-translated="true"]').forEach(node => {
            if (node.dataset.originalText) {
                node.innerText = node.dataset.originalText;
            }
            delete node.dataset.ytTranslated;
            delete node.dataset.originalText;
        });

        if (settings.debugMode) console.log(DEBUG_PREFIX, "YouTube字幕翻译监控已停止，并已还原字幕。");
    }
}

// --- 翻译与内容还原 (保持不变) ---
function restoreOriginalContent() {
    document.body.dataset.translationState = 'original';
    const translatedElements = document.querySelectorAll('[data-is-translated="true"]');
    translatedElements.forEach(element => {
        if (element.dataset.originalContent) {
            element.innerHTML = element.dataset.originalContent;
        }
        delete element.dataset.isTranslated;
        delete element.dataset.originalContent;
    });
    if (settings.debugMode) console.log(DEBUG_PREFIX, `已还原 ${translatedElements.length} 个元素。`);
}

async function translatePageByParagraphs(rootElement) {
    document.body.dataset.translationState = 'translated';
    const paragraphs = findParagraphs(rootElement);
    if (paragraphs.length === 0) return;
    if (settings.debugMode) console.log(DEBUG_PREFIX, `找到 ${paragraphs.length} 个段落准备翻译。`);
    const CHUNK_SIZE = settings.engine === 'gemini' ? 100 : 10;
    for (let i = 0; i < paragraphs.length; i += CHUNK_SIZE) {
        const chunk = paragraphs.slice(i, i + CHUNK_SIZE);
        const textsToTranslate = chunk.map(p => p.innerText.trim()).filter(Boolean);
        if (textsToTranslate.length === 0) continue;
        try {
            const translatedTexts = await translateChunk(textsToTranslate);
            if (translatedTexts && translatedTexts.length === textsToTranslate.length) {
                chunk.forEach((p, index) => {
                    if(textsToTranslate[index]) {
                         appendTranslation(p, translatedTexts[index]);
                    }
                });
            }
        } catch (error) {
            if (settings.debugMode) console.error(DEBUG_PREFIX, `段落块翻译失败:`, error);
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
    }
}

function findParagraphs(root) {
    const elements = root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, th, td, blockquote, div, span, [data-testid="tweetText"]');
    const paragraphs = [];
    elements.forEach(el => {
        if (el.offsetParent === null || el.dataset.isTranslated || el.closest('[data-is-translated="true"], a, button, [role="button"], [role="link"], script, style, noscript, .custom-translator-wrapper')) {
            return;
        }
        if (el.querySelector('[data-is-translated="true"]')) {
            return;
        }
        const text = el.innerText.trim();
        if (!text || text.length < 5) {
            return;
        }
        let hasBlockChild = false;
        for(let child of el.children) {
            const display = window.getComputedStyle(child).display;
            if(display === 'block' || display === 'flex' || display === 'grid') {
                hasBlockChild = true;
                break;
            }
        }
        if (hasBlockChild) return;
        paragraphs.push(el);
    });
    return paragraphs;
}

function appendTranslation(element, translatedText) {
    if (element.dataset.isTranslated || !translatedText) return;
    element.dataset.originalContent = element.innerHTML;
    element.dataset.isTranslated = "true";
    const translationElement = document.createElement('div');
    translationElement.className = 'translated-text';
    translationElement.innerText = `(${translatedText.trim()})`;
    element.appendChild(translationElement);
}

// --- 翻译API调用核心 (保持不变) ---
async function translateChunk(texts) {
    const BATCH_DELIMITER = '\n<br>\n';
    const joinedText = texts.join(BATCH_DELIMITER);
    const translatedJoinedText = await translateWithRetry(joinedText);
    if (translatedJoinedText && !translatedJoinedText.startsWith("翻译错误")) {
        return translatedJoinedText.split(BATCH_DELIMITER);
    }
    return texts.map(() => translatedJoinedText);
}

async function translateWithRetry(text, retries = 3, defaultDelay = 1000) {
    try {
        return await translateSingleText(text);
    } catch (error) {
        if (retries > 0) {
            let delay = defaultDelay;
            if (error.retryDelay) {
                delay = error.retryDelay;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            return translateWithRetry(text, retries - 1, error.retryDelay ? defaultDelay : defaultDelay * 2);
        } else {
            return `翻译错误: ${error.message}`;
        }
    }
}

async function translateSingleText(text) {
    const cacheKey = `${settings.engine}:${settings.targetLanguage}:${text}`;
    if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
    let result = '';
    switch (settings.engine) {
        case 'gemini': result = await translateWithGemini(text);
            break;
        default: result = await translateWithGoogle(text);
    }
    if (result && !result.startsWith('翻译错误')) {
        translationCache.set(cacheKey, result);
        // 持久化缓存
        chrome.storage.local.set({ 'translationCache': Object.fromEntries(translationCache) });
    }
    return result;
}

// --- 各个API的实现 (保持不变) ---
async function translateWithGoogle(text) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${settings.targetLanguage}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Google翻译HTTP错误: ${response.status}`);
    }
    const data = await response.json();
    let translatedText = '';
    if (data && data[0]) {
        data[0].forEach(segment => {
            if(segment[0]) {
                translatedText += segment[0];
            }
        });
    }
    return translatedText;
}

async function translateWithGemini(text) {
    if (!settings.geminiApiKey) { throw new Error("Gemini API key not set."); }
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${settings.geminiApiKey}`;
    const finalPrompt = `Translate the following text to ${settings.targetLanguage}. Maintain the original line breaks and structure. Do not add any extra explanations or text, only provide the direct translation.\n\nOriginal Text:\n${text}\n\nTranslated Text:`;
    const payload = {
        "contents": [{ "parts": [{ "text": finalPrompt }] }],
        "generationConfig": { "temperature": 0.2, "topP": 0.95, "topK": 40 },
        "safetySettings": [
            { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
            { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
        ]
    };
    const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) {
        const errorData = await response.json();
        const retryDelayString = errorData?.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
        const err = new Error(`Gemini翻译HTTP错误: ${response.status}`);
        if (retryDelayString) {
            const seconds = parseInt(retryDelayString, 10);
            err.retryDelay = seconds * 1000;
        }
        throw err;
    }
    const data = await response.json();
    if (!data.candidates || data.candidates.length === 0) {
        const finishReason = data.promptFeedback?.blockReason;
        if (finishReason) {
             return `翻译失败 (内容被阻止: ${finishReason})`;
        }
        return "翻译失败 (无返回内容)";
    }
    return data.candidates[0]?.content?.parts?.[0]?.text || "翻译失败";
}

// --- 通用函数 (保持不变) ---
function showNotification(message) {
    let notification = document.createElement('div');
    notification.className = 'custom-translator-notification';
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => document.body.removeChild(notification), 500);
    }, 3000);
}

// --- 字幕翻译样式 ---
const subtitleStyle = document.createElement('style');
document.head.appendChild(subtitleStyle);
