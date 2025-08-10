// 文件名: background.js
// v1.9.0: 添加 YouTube 字幕请求监听

// --- 核心功能：更新右键菜单状态 ---
async function updateContextMenu(tabId) {
    try {
        const result = await chrome.storage.session.get([`tab_${tabId}`]);
        const isTranslated = result[`tab_${tabId}`] || false;

        chrome.contextMenus.update("toggleTranslate", {
            title: isTranslated ? "显示原文" : "翻译此页面 (双语对照)",
        });
    } catch (e) {
        // 在无效的tabId上操作会报错，这里静默处理
    }
}

// --- 事件监听 ---

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "toggleTranslate",
        title: "翻译此页面 (双语对照)",
        contexts: ["page"]
    });
});

chrome.tabs.onActivated.addListener(activeInfo => {
    updateContextMenu(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        // 重置翻译状态当页面刷新或导航时
        chrome.storage.session.set({ [`tab_${tabId}`]: false }, () => {
            updateContextMenu(tabId);
        });
        // 清除旧的字幕 URL
        chrome.storage.session.remove(`youtube_subtitle_url_${tabId}`);
    }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "toggleTranslate") {
        try {
            const result = await chrome.storage.session.get([`tab_${tab.id}`]);
            const isCurrentlyTranslated = result[`tab_${tab.id}`] || false;
            const action = isCurrentlyTranslated ? 'restore' : 'translate';

            await chrome.tabs.sendMessage(tab.id, { action: action });
        } catch (e) {
            console.error("Error sending message to content script:", e);
        }
    }
});

// --- 新功能: YouTube 字幕网络请求监听 ---
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        // 确保请求来自一个有效的标签页，并且是我们需要的json3格式字幕
        if (details.tabId > 0 && details.url.includes('fmt=json3')) {
            chrome.storage.session.set({ [`youtube_subtitle_url_${details.tabId}`]: details.url });
            // 通知内容脚本URL已捕获，可以启用翻译按钮了
            chrome.tabs.sendMessage(details.tabId, { action: "youtubeSubtitleUrlReady" }).catch(e => {
                 // 如果内容脚本尚未注入或准备好，这里会报错，属于正常现象，静默处理
            });
        }
    },
    { urls: ["*://*.youtube.com/api/timedtext*"] }
);


// 监听内容脚本的消息请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (!tabId) return true; // 如果没有tabId，则忽略

    if (request.action === 'updateTranslationState') {
        chrome.storage.session.set({ [`tab_${tabId}`]: request.isTranslated }, () => {
            updateContextMenu(tabId);
            sendResponse({ status: 'ok' });
        });
        return true; // 异步响应
    } else if (request.action === 'getYoutubeSubtitleUrl') {
        chrome.storage.session.get([`youtube_subtitle_url_${tabId}`]).then(result => {
            sendResponse({ url: result[`youtube_subtitle_url_${tabId}`] });
        });
        return true; // 异步响应
    }
    return false;
});
