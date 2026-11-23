window.unlockedStickerPacks = window.unlockedStickerPacks || [];
const STICKER_PACKS = [
    { id: 'hot-cherry', name: 'Hot Cherry', price: 200, icon: '🍒', folder: 'hot-cherry', filePrefix: 'HotCherry' },
    { id: 'funky-goose', name: 'Funky Goose', price: 250, icon: '🪿', folder: 'funky-goose', filePrefix: 'FunkyGoose' },
    { id: 'shpooky', name: 'Shpooky', price: 300, icon: '👻', folder: 'shpooky', filePrefix: 'Shpooky' }
];

let stickerBrowserMode = 'store';
let selectedStickerPack = null;
const stickerAnimations = new WeakMap();
const stickerAnimationElements = new Set();
const stickerDataCache = new Map();
const stickerLoadQueue = [];
let activeStickerLoads = 0;
let lottieLoadPromise = null;
const MAX_CONCURRENT_STICKER_LOADS = 2;
const stickerObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const element = entry.target;
            const animation = stickerAnimations.get(element);
            if (entry.isIntersecting) {
                element.dataset.stickerVisible = 'true';
                if (animation) animation.play();
                else queueStickerLoad(element);
            } else {
                element.dataset.stickerVisible = 'false';
                if (animation) animation.pause();
                if (!element.isConnected) {
                    stickerObserver.unobserve(element);
                    const detachedAnimation = stickerAnimations.get(element);
                    if (detachedAnimation) detachedAnimation.destroy();
                    stickerAnimations.delete(element);
                    stickerAnimationElements.delete(element);
                }
            }
        });
    }, { root: null, rootMargin: '48px', threshold: 0.01 })
    : null;

function ensureLottieLoaded() {
    if (window.lottie) return Promise.resolve(true);
    if (!lottieLoadPromise) {
        lottieLoadPromise = new Promise(resolve => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js';
            script.async = true;
            script.onload = () => resolve(!!window.lottie);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
    }
    return lottieLoadPromise;
}

function getStickerPack(packId) {
    return STICKER_PACKS.find(pack => pack.id === packId) || null;
}

function getStickerPath(packId, number) {
    const pack = getStickerPack(packId);
    if (!pack || number < 1 || number > 12) return '';
    return `stickers/${pack.folder}/${pack.filePrefix}-${String(number).padStart(2, '0')}.tgs`;
}

function getStickerId(packId, number) {
    return `${packId}:${number}`;
}

function parseStickerId(stickerId) {
    const parts = String(stickerId || '').split(':');
    const pack = getStickerPack(parts[0]);
    const number = Number(parts[1]);
    if (!pack || !Number.isInteger(number) || number < 1 || number > 12) return null;
    return { pack, number };
}

const STICKER_FALLBACKS = {
    'hot-cherry': ['🍒','🍓','🍉','🍎','🍑','❤️','💋','🌹','🍬','🧁','💗','✨'],
    'funky-goose': ['🪿','🦆','🐥','🐸','🐧','🕶️','🎸','🪩','😎','🤪','💃','🛼'],
    'shpooky': ['👻','🎃','🦇','🕷️','🕸️','💀','🧙','🧛','🧟','🌙','🖤','✨']
};

function showStickerFallback(element, parsed) {
    const emojis = STICKER_FALLBACKS[parsed.pack.id] || ['⭐'];
    element.innerHTML = '';
    element.classList.add('sticker-fallback');
    element.textContent = emojis[parsed.number - 1] || '⭐';
    element.setAttribute('aria-label', `${parsed.pack.name} ${parsed.number}`);
}

async function getStickerAnimationData(stickerId, parsed) {
    if (stickerDataCache.has(stickerId)) return stickerDataCache.get(stickerId);
    const dataPromise = (async () => {
        const response = await fetch(getStickerPath(parsed.pack.id, parsed.number), { cache: 'force-cache' });
        if (!response.ok) throw new Error(`Sticker file unavailable: ${response.status}`);
        const compressedBlob = await response.blob();
        let jsonText;
        if (typeof DecompressionStream !== 'undefined') {
            const stream = compressedBlob.stream().pipeThrough(new DecompressionStream('gzip'));
            jsonText = await new Response(stream).text();
        } else if (window.pako) {
            const compressed = new Uint8Array(await compressedBlob.arrayBuffer());
            jsonText = window.pako.ungzip(compressed, { to: 'string' });
        } else {
            throw new Error('Gzip decompression is not supported in this browser');
        }
        return JSON.parse(jsonText);
    })();
    stickerDataCache.set(stickerId, dataPromise);
    while (stickerDataCache.size > 8) {
        const oldestKey = stickerDataCache.keys().next().value;
        if (oldestKey === stickerId) break;
        stickerDataCache.delete(oldestKey);
    }
    try {
        return await dataPromise;
    } catch (error) {
        stickerDataCache.delete(stickerId);
        throw error;
    }
}

function queueStickerLoad(element) {
    if (!element || !element.isConnected || element.dataset.stickerLoading === 'true' || element.dataset.stickerLoaded === 'true' || element.dataset.stickerFailed === 'true') return;
    if (!window.lottie) {
        ensureLottieLoaded().then(loaded => {
            if (loaded && element.isConnected && element.dataset.stickerVisible === 'true') queueStickerLoad(element);
            else if (!loaded && element.isConnected) element.dataset.stickerFailed = 'true';
        });
        return;
    }
    if (stickerLoadQueue.some(item => item.element === element)) return;
    stickerLoadQueue.push({ element, stickerId: element.dataset.stickerId });
    pumpStickerLoadQueue();
}

function pumpStickerLoadQueue() {
    while (activeStickerLoads < MAX_CONCURRENT_STICKER_LOADS && stickerLoadQueue.length) {
        const item = stickerLoadQueue.shift();
        if (!item.element.isConnected || item.element.dataset.stickerVisible !== 'true') continue;
        activeStickerLoads++;
        item.element.dataset.stickerLoading = 'true';
        createStickerAnimation(item.element, item.stickerId).finally(() => {
            activeStickerLoads--;
            item.element.dataset.stickerLoading = 'false';
            if (item.element.isConnected && item.element.dataset.stickerVisible === 'true' && item.element.dataset.stickerLoaded !== 'true' && item.element.dataset.stickerFailed !== 'true') {
                queueStickerLoad(item.element);
            }
            pumpStickerLoadQueue();
        });
    }
}

async function createStickerAnimation(element, stickerId) {
    const parsed = parseStickerId(stickerId);
    if (!parsed || !element.isConnected) return;
    try {
        const animationData = await getStickerAnimationData(stickerId, parsed);
        if (!element.isConnected || element.dataset.stickerVisible !== 'true') return;
        const animation = window.lottie.loadAnimation({
            container: element,
            renderer: 'svg',
            loop: true,
            autoplay: false,
            animationData: JSON.parse(JSON.stringify(animationData)),
            rendererSettings: { progressiveLoad: true, preserveAspectRatio: 'xMidYMid meet' }
        });
        animation.setSubframe(false);
        stickerAnimations.set(element, animation);
        stickerAnimationElements.add(element);
        element.dataset.stickerLoaded = 'true';
        element.classList.remove('sticker-fallback');
        animation.addEventListener('DOMLoaded', () => {
            if (element.dataset.stickerVisible === 'true') animation.play();
            else animation.pause();
        });
    } catch (error) {
        if (element.isConnected) {
            element.dataset.stickerFailed = 'true';
            showStickerFallback(element, parsed);
        }
    }
}

function cleanupDetachedStickerAnimations() {
    stickerAnimationElements.forEach(element => {
        if (!element.isConnected) {
            const animation = stickerAnimations.get(element);
            if (animation) animation.destroy();
            stickerAnimations.delete(element);
            stickerAnimationElements.delete(element);
            if (stickerObserver) stickerObserver.unobserve(element);
        }
    });
}

function destroyStickerAnimationsWithin(container) {
    if (!container) return;
    stickerAnimationElements.forEach(element => {
        if (container.contains(element)) {
            const animation = stickerAnimations.get(element);
            if (animation) animation.destroy();
            stickerAnimations.delete(element);
            stickerAnimationElements.delete(element);
            if (stickerObserver) stickerObserver.unobserve(element);
        }
    });
    for (let i = stickerLoadQueue.length - 1; i >= 0; i--) {
        if (container.contains(stickerLoadQueue[i].element)) stickerLoadQueue.splice(i, 1);
    }
}

function loadStickerAnimation(element, stickerId) {
    cleanupDetachedStickerAnimations();
    if (!element) return;
    const parsed = parseStickerId(stickerId);
    if (!parsed) return;
    element.dataset.stickerId = stickerId;
    element.dataset.stickerVisible = 'false';
    showStickerFallback(element, parsed);
    if (stickerObserver) {
        stickerObserver.observe(element);
    } else {
        element.dataset.stickerVisible = 'true';
        queueStickerLoad(element);
    }
}

function renderStickerTiles(container, packId, numbers, onSelect) {
    container.innerHTML = '';
    numbers.forEach(number => {
        const stickerId = getStickerId(packId, number);
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'sticker-tile';
        tile.setAttribute('aria-label', `استیکر ${number}`);
        const animation = document.createElement('div');
        animation.className = 'sticker-animation';
        tile.appendChild(animation);
        if (onSelect) tile.addEventListener('click', () => onSelect(stickerId));
        container.appendChild(tile);
        loadStickerAnimation(animation, stickerId);
    });
}

function openStickerStore() {
    stickerBrowserMode = 'store';
    selectedStickerPack = null;
    renderStickerBrowser();
    openModal('sticker-browser-modal');
}

function openStickerPackInStore(packId) {
    stickerBrowserMode = 'store';
    selectedStickerPack = packId;
    renderStickerBrowser();
}

function openStickerPicker() {
    const isGuest = currentName === 'Guest' || currentName.startsWith('Guest.');
    if (isGuest) {
        showGuestModal();
        return;
    }
    stickerBrowserMode = 'chat';
    selectedStickerPack = null;
    renderStickerBrowser();
    openModal('sticker-browser-modal');
}

function renderStickerBrowser() {
    const title = document.getElementById('sticker-browser-title');
    const body = document.getElementById('sticker-browser-body');
    const footer = document.getElementById('sticker-browser-footer');
    if (!title || !body || !footer) return;
    destroyStickerAnimationsWithin(body);
    footer.innerHTML = '';

    if (!selectedStickerPack) {
        title.textContent = 'استیکرها';
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'close-btn sticker-browser-action';
        closeButton.textContent = stickerBrowserMode === 'chat' ? 'بستن' : 'بازگشت';
        closeButton.addEventListener('click', () => {
            closeModal();
            if (stickerBrowserMode === 'store') openModal('shop-modal');
        });
        footer.appendChild(closeButton);

        const packs = stickerBrowserMode === 'store'
            ? STICKER_PACKS
            : STICKER_PACKS.filter(pack => unlockedStickerPacks.includes(pack.id));

        if (!packs.length) {
            body.innerHTML = '<div class="sticker-empty"><svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sticker preview-icon"><path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/><path d="M8 13h.01"/><path d="M16 13h.01"/><path d="M10 16s.8 1 2 1c1.3 0 2-1 2-1"/></svg><span>هنوز پک استیکر نخریدی.</span></div>';
            return;
        }

        body.innerHTML = '<div class="sticker-pack-list"></div>';
        const list = body.querySelector('.sticker-pack-list');
        packs.forEach(pack => {
            const owned = unlockedStickerPacks.includes(pack.id);
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'sticker-pack-card';
            card.innerHTML = `<div class="sticker-pack-heading"><span class="sticker-pack-name">${pack.name}</span></div><div class="sticker-pack-preview"><div></div><div></div><div></div></div><div class="sticker-pack-meta">${stickerBrowserMode === 'store' ? (owned ? 'خریداری شده' : `<span>${pack.price}</span><svg class="sticker-coin-icon" viewBox="0 0 24 24" fill="none" stroke="var(--coin-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>`) : '۱۲ استیکر'}</div>`;
            card.addEventListener('click', () => {
                selectedStickerPack = pack.id;
                renderStickerBrowser();
            });
            list.appendChild(card);
            const previews = card.querySelectorAll('.sticker-pack-preview > div');
            [1, 2, 3].forEach((number, index) => loadStickerAnimation(previews[index], getStickerId(pack.id, number)));
        });
        return;
    }

    const pack = getStickerPack(selectedStickerPack);
    if (!pack) {
        selectedStickerPack = null;
        renderStickerBrowser();
        return;
    }

    const owned = unlockedStickerPacks.includes(pack.id);
    title.textContent = stickerBrowserMode === 'chat' ? 'استیکرها' : pack.name;
    body.innerHTML = '<div class="sticker-grid"></div>';
    const grid = body.querySelector('.sticker-grid');
    renderStickerTiles(grid, pack.id, Array.from({ length: 12 }, (_, i) => i + 1), stickerId => {
        if (stickerBrowserMode === 'chat') sendSelectedSticker(stickerId);
    });

    if (stickerBrowserMode === 'store') {
        const buyButton = document.createElement('button');
        buyButton.type = 'button';
        buyButton.className = 'sticker-browser-buy';
        buyButton.innerHTML = owned ? 'خریداری شده' : `خرید / ${pack.price} <svg class="sticker-coin-icon" viewBox="0 0 24 24" fill="none" stroke="var(--coin-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>`;
        buyButton.disabled = owned;
        buyButton.addEventListener('click', () => buyStickerPack(pack.id));

        const backButton = document.createElement('button');
        backButton.type = 'button';
        backButton.className = 'close-btn sticker-browser-action';
        backButton.textContent = 'بازگشت';
        backButton.addEventListener('click', () => {
            selectedStickerPack = null;
            renderStickerBrowser();
        });

        footer.appendChild(buyButton);
        footer.appendChild(backButton);
    } else {
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'close-btn sticker-browser-action';
        closeButton.textContent = 'بستن';
        closeButton.addEventListener('click', () => closeModal());
        footer.appendChild(closeButton);
    }
}

async function buyStickerPack(packId) {
    const pack = getStickerPack(packId);
    if (!pack || unlockedStickerPacks.includes(packId)) return;
    const button = document.querySelector('.sticker-browser-buy');
    if (button) {
        button.disabled = true;
        button.textContent = 'در حال خرید...';
    }
    const { data, error } = await supabaseClient.rpc('purchase_sticker_pack', {
        p_device_id: getDeviceId(),
        p_pack_id: packId
    });
    if (error || !data || !data.ok) {
        if (button) {
            button.disabled = false;
            button.textContent = 'خرید';
        }
        const message = data && data.message === 'insufficient_coins'
            ? 'سکه کافی برای خرید این پک نداری.'
            : 'خرید انجام نشد. اتصال دیتابیس و اجرای SQL را بررسی کن.';
        showCustomAlert('خرید ناموفق', message, 'error');
        return;
    }
    currentCoins = Number(data.coins);
    unlockedStickerPacks = Array.isArray(data.unlocked_packs) ? data.unlocked_packs : [...unlockedStickerPacks, packId];
    updateCoinsUI();
    renderStickerBrowser();
    showCustomAlert('خرید موفق', `پک ${pack.name} با موفقیت باز شد.`, 'success');
}

function sendSelectedSticker(stickerId) {
    const parsed = parseStickerId(stickerId);
    if (!parsed || !unlockedStickerPacks.includes(parsed.pack.id)) return;
    if (stickerBrowserMode !== 'chat') return;
    if (currentChatContext === 'private' && activePrivateChat) {
        sendPrivateSticker(stickerId);
    } else {
        sendPanelSticker(stickerId);
    }
    closeModal();
}

async function sendPanelSticker(stickerId) {
    const isGuest = currentName === 'Guest' || currentName.startsWith('Guest.');
    if (isGuest) {
        showGuestModal();
        return;
    }
    const { data, error } = await supabaseClient.from('messages').insert([{
        sender_name: currentName,
        text: '',
        message_type: 'sticker',
        sticker_id: stickerId
    }]).select();
    if (error) {
        showCustomAlert('خطا', 'ارسال استیکر انجام نشد.', 'error');
        return;
    }
    const msg = data && data[0];
    if (msg && !document.querySelector(`[data-msg-id="${msg.id}"]`)) {
        appendPanelChatMessage(msg, currentCustomAvatarUrl || defaultAvatar, currentFrame || 'none');
    }
}

async function sendPrivateSticker(stickerId) {
    if (!activePrivateChat) return;
    const { data, error } = await supabaseClient.from('private_messages').insert([{
        sender_name: currentName,
        receiver_name: activePrivateChat,
        text: '',
        message_type: 'sticker',
        sticker_id: stickerId
    }]).select();
    if (error) {
        showCustomAlert('خطا', 'ارسال استیکر انجام نشد.', 'error');
        return;
    }
    const msg = data && data[0];
    const container = document.getElementById('private-messages-container');
    if (msg && container && !document.querySelector(`[data-private-msg-id="${msg.id}"]`)) {
        appendPrivateMessageUI(msg);
        container.scrollTop = container.scrollHeight;
    }
}

function createStickerMessageElement(stickerId) {
    const parsed = parseStickerId(stickerId);
    const element = document.createElement('div');
    element.className = 'chat-sticker-message';
    if (!parsed) {
        element.textContent = 'استیکر';
        return element;
    }
    loadStickerAnimation(element, stickerId);
    return element;
}
