// 文件名: popup.js
// v1.8.1: 适配精简后的UI和调试模式

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const engineSwitch = document.getElementById('engine-switch');
    const languageSelect = document.getElementById('language-select');
    const debugSwitch = document.getElementById('debug-switch');
    const saveButton = document.getElementById('save-button');
    const clearCacheButton = document.getElementById('clear-cache-button');
    const statusDiv = document.getElementById('status');
    const geminiSettingsDiv = document.getElementById('gemini-settings');
    const geminiKeyInput = document.getElementById('gemini-key');

    // Settings to manage
    const settingsToLoad = ['engine', 'targetLanguage', 'geminiApiKey', 'debugMode'];

    // Load settings and initialize UI
    chrome.storage.sync.get(settingsToLoad, (result) => {
        const useGemini = result.engine === 'gemini';
        engineSwitch.checked = useGemini;
        geminiSettingsDiv.style.display = useGemini ? 'block' : 'none';

        languageSelect.value = result.targetLanguage || 'zh-CN';
        geminiKeyInput.value = result.geminiApiKey || '';
        debugSwitch.checked = result.debugMode || false;
    });

    // Event Listeners
    engineSwitch.addEventListener('change', () => {
        geminiSettingsDiv.style.display = engineSwitch.checked ? 'block' : 'none';
    });
    saveButton.addEventListener('click', saveSettings);
    clearCacheButton.addEventListener('click', clearCache);

    // Functions
    function saveSettings() {
        const settingsToSave = {
            engine: engineSwitch.checked ? 'gemini' : 'google',
            targetLanguage: languageSelect.value,
            geminiApiKey: geminiKeyInput.value.trim(),
            debugMode: debugSwitch.checked,
        };

        chrome.storage.sync.set(settingsToSave, () => {
            showStatus('设置已成功保存！');
        });
    }

    function clearCache() {
        chrome.storage.local.remove('translationCache', () => {
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                if (tabs && tabs.length > 0 && tabs[0].id) {
                    chrome.tabs.sendMessage(tabs[0].id, {action: "clearCache"}).catch(error => {
                        if (!error.message.includes("Receiving end does not exist")) {
                            console.error("清除缓存消息发送失败:", error);
                        }
                    });
                }
            });
            showStatus('缓存已清除！');
        });
    }

    function showStatus(message) {
        statusDiv.textContent = message;
        setTimeout(() => { statusDiv.textContent = ''; }, 2500);
    }
});
