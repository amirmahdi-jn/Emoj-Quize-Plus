let tttGame = null;
let tttSubscription = null;
let tttPresenceChannel = null;
let tttQueuePresenceChannel = null;
let tttTimerInterval = null;
let tttDisconnectInterval = null;
let tttPresenceMissingTimer = null;
let tttDisconnectDeadline = 0;
let tttDisconnectingPlayer = null;
let tttEnteringGame = false;
let tttLocalTurnStart = 0;
let tttTimeoutFired = false;
let tttLeaveConfirmOpen = false;
let tttRewarded = false;
let tttMovePending = false;
let tttSearchInterval = null;
let tttSearching = false;
let tttEntryPaid = false;
let tttSearchToken = 0;
let tttSearchStartedAt = 0;

const TTT_TURN_SECONDS = 15;
const TTT_DISCONNECT_SECONDS = 15;
const TTT_WAITING_EXPIRY_SECONDS = 60;
const TTT_TROPHY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
const TTT_COIN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f1c40f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>`;

function clearTTTSearchInterval() {
    if (tttSearchInterval) { clearInterval(tttSearchInterval); tttSearchInterval = null; }
}

function clearTTTDisconnectTimer() {
    if (tttPresenceMissingTimer) { clearTimeout(tttPresenceMissingTimer); tttPresenceMissingTimer = null; }
    if (tttDisconnectInterval) { clearInterval(tttDisconnectInterval); tttDisconnectInterval = null; }
    tttDisconnectDeadline = 0;
    tttDisconnectingPlayer = null;
    const overlay = document.getElementById('ttt-disconnect-overlay');
    if (overlay) overlay.remove();
}

function getTTTTimeoutStorageKey(gameId) {
    return `ttt_timeout_streak_${gameId}_${currentName}`;
}

function getTTTTimeoutStreak(gameId) {
    try { return Number(localStorage.getItem(getTTTTimeoutStorageKey(gameId))) || 0; }
    catch (e) { return 0; }
}

function setTTTTimeoutStreak(gameId, streak) {
    try {
        if (streak <= 0) localStorage.removeItem(getTTTTimeoutStorageKey(gameId));
        else localStorage.setItem(getTTTTimeoutStorageKey(gameId), String(streak));
    } catch (e) {}
}

function getTTTRewardStorageKey(gameId) {
    return `ttt_rewarded_${gameId}_${currentName}`;
}

function getTTTPendingSearchStorageKey() {
    return `ttt_pending_search_${currentName}`;
}

function setTTTPendingSearchId(gameId) {
    try { localStorage.setItem(getTTTPendingSearchStorageKey(), String(gameId)); } catch (e) {}
}

function clearTTTPendingSearchId() {
    try { localStorage.removeItem(getTTTPendingSearchStorageKey()); } catch (e) {}
}

function hasTTTRewardBeenApplied(gameId) {
    try { return localStorage.getItem(getTTTRewardStorageKey(gameId)) === '1'; }
    catch (e) { return false; }
}

function markTTTRewardApplied(gameId) {
    try { localStorage.setItem(getTTTRewardStorageKey(gameId), '1'); } catch (e) {}
}

function tttPayEntry() {
    if (tttEntryPaid) return true;
    if (currentCoins < 25) return false;
    currentCoins -= 25;
    tttEntryPaid = true;
    updateAllStatsUI();
    syncToDatabase();
    return true;
}

async function tttRefundEntry() {
    if (!tttEntryPaid) return;
    currentCoins += 25;
    tttEntryPaid = false;
    updateAllStatsUI();
    await syncToDatabase();
}

async function tttCleanupWaitingGame() {
    if (!tttGame) return;
    if (tttGame.status === 'waiting' && tttGame.player1_name === currentName) {
        await supabaseClient.from('ttt_games').delete().eq('id', tttGame.id).eq('status', 'waiting');
    }
}

function tttQueuePresenceNames() {
    if (!tttQueuePresenceChannel) return [];
    const state = tttQueuePresenceChannel.presenceState();
    return Object.keys(state).map(key => {
        const records = state[key] || [];
        return records.find(p => p.name)?.name || key;
    });
}

async function tttSubscribeToQueuePresence(token) {
    if (tttQueuePresenceChannel) {
        try { await supabaseClient.removeChannel(tttQueuePresenceChannel); } catch (e) {}
        tttQueuePresenceChannel = null;
    }
    const channel = supabaseClient.channel('ttt_matchmaking_presence', {
        config: { presence: { key: currentName } }
    });
    tttQueuePresenceChannel = channel;
    return new Promise((resolve, reject) => {
        channel.subscribe(async (status) => {
            if (token !== tttSearchToken || !tttSearching) return;
            if (status === 'SUBSCRIBED') {
                try {
                    await channel.track({ name: currentName, searching: true, started_at: new Date().toISOString() });
                    resolve(true);
                } catch (error) { reject(error); }
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                reject(new Error('Queue presence subscription failed'));
            }
        });
    });
}

async function startTTTMatchmaking() {
    if (tttSearching) return;
    tttSearching = true;
    tttEnteringGame = false;
    tttSearchStartedAt = Date.now();
    const token = ++tttSearchToken;
    clearTTTSearchInterval();

    try {
        await tttSubscribeToQueuePresence(token);
        if (token !== tttSearchToken || !tttSearching) return;

        const cutoff = new Date(Date.now() - TTT_WAITING_EXPIRY_SECONDS * 1000).toISOString();
        await supabaseClient.from('ttt_games').delete().eq('status', 'waiting').lt('created_at', cutoff);
        const { data: waitingGames } = await supabaseClient
            .from('ttt_games')
            .select('*')
            .eq('status', 'waiting')
            .neq('player1_name', currentName)
            .gte('created_at', cutoff)
            .order('created_at', { ascending: true })
            .limit(10);

        if (token !== tttSearchToken || !tttSearching) return;

        const activeSearchers = tttQueuePresenceNames();
        const candidate = (waitingGames || []).find(g => activeSearchers.includes(g.player1_name));
        if (candidate) {
            const mySymbol = candidate.player1_symbol === 'X' ? 'O' : 'X';
            const { data, error } = await supabaseClient
                .from('ttt_games')
                .update({
                    player2_name: currentName,
                    player2_symbol: mySymbol,
                    status: 'playing',
                    current_turn: candidate.player1_name,
                    updated_at: new Date().toISOString()
                })
                .eq('id', candidate.id)
                .eq('status', 'waiting')
                .eq('player1_name', candidate.player1_name)
                .select()
                .maybeSingle();

            if (token !== tttSearchToken || !tttSearching) {
                if (data) await supabaseClient.from('ttt_games').update({ status: 'finished', result: 'player2_left' }).eq('id', data.id).eq('status', 'playing');
                return;
            }

            if (data && !error) {
                tttGame = data;
                tttSearching = false;
                clearTTTSearchInterval();
                if (!tttEnteringGame) {
                    tttEnteringGame = true;
                    subscribeToTTTGame(data.id);
                    enterTTTGame();
                }
                return;
            }
        }

        const mySymbol = Math.random() < 0.5 ? 'X' : 'O';
        const { data: created, error } = await supabaseClient
            .from('ttt_games')
            .insert({
                player1_name: currentName,
                player1_symbol: mySymbol,
                player2_symbol: mySymbol === 'X' ? 'O' : 'X',
                current_turn: currentName,
                status: 'waiting',
                board: ["","","","","","","","",""]
            })
            .select()
            .maybeSingle();

        if (token !== tttSearchToken || !tttSearching) {
            if (created) await supabaseClient.from('ttt_games').delete().eq('id', created.id).eq('status', 'waiting');
            return;
        }

        if (!created || error) {
            tttSearching = false;
            await tttRefundEntry();
            updateSearchText('خطا در ساخت بازی. سکه برگشت داده شد.');
            return;
        }

        tttGame = created;
        setTTTPendingSearchId(created.id);
        subscribeToTTTGame(created.id);

        tttSearchInterval = setInterval(async () => {
            if (token !== tttSearchToken || !tttSearching || !tttGame || tttGame.id !== created.id || tttGame.status !== 'waiting') {
                clearTTTSearchInterval();
                return;
            }
            if (Date.now() - tttSearchStartedAt >= TTT_WAITING_EXPIRY_SECONDS * 1000) {
                clearTTTSearchInterval();
                await supabaseClient.from('ttt_games').delete().eq('id', created.id).eq('status', 'waiting');
                tttGame = null;
                clearTTTPendingSearchId();
                tttSearching = false;
                if (tttQueuePresenceChannel) { try { await tttQueuePresenceChannel.untrack(); } catch (e) {} supabaseClient.removeChannel(tttQueuePresenceChannel); tttQueuePresenceChannel = null; }
                await tttRefundEntry();
                updateSearchText('حریفی پیدا نشد؛ سکه ورودی برگشت داده شد.');
                return;
            }
            const { data: check } = await supabaseClient
                .from('ttt_games')
                .select('*')
                .eq('id', created.id)
                .maybeSingle();
            if (token !== tttSearchToken || !tttSearching) return;
            if (check && check.status === 'playing' && check.player2_name) {
                clearTTTSearchInterval();
                tttGame = check;
                tttSearching = false;
                if (!tttEnteringGame && document.getElementById('online-search-screen')?.classList.contains('active')) {
                    tttEnteringGame = true;
                    enterTTTGame();
                }
            }
        }, 500);
    } catch (e) {
        if (token !== tttSearchToken) return;
        tttSearching = false;
        if (tttQueuePresenceChannel) { try { await tttQueuePresenceChannel.untrack(); } catch (e) {} supabaseClient.removeChannel(tttQueuePresenceChannel); tttQueuePresenceChannel = null; }
        await tttRefundEntry();
        updateSearchText('خطا در اتصال. دوباره تلاش کنید.');
    }
}

function updateSearchText(text) {
    const el = document.getElementById('search-status-text');
    if (el) el.textContent = text;
}

function openOnlineGame(gameType) {
    if (gameType !== 'tictactoe') return;
    if (currentName === 'Guest' || currentName.startsWith('Guest.')) {
        showGuestModal();
        return;
    }
    if (currentCoins < 25) {
        openModal('no-coin-modal');
        return;
    }
    if (!tttPayEntry()) {
        openModal('no-coin-modal');
        return;
    }
    const nameEl = document.getElementById('search-game-name');
    if (nameEl) nameEl.innerText = 'دوز';
    updateSearchText('در حال جستجوی حریف...');
    showScreen('online-search-screen');
    startTTTMatchmaking();
}

async function cancelOnlineSearch() {
    tttSearchToken++;
    tttSearching = false;
    clearTTTSearchInterval();
    if (tttQueuePresenceChannel) {
        try { await tttQueuePresenceChannel.untrack(); } catch (e) {}
        try { await supabaseClient.removeChannel(tttQueuePresenceChannel); } catch (e) {}
        tttQueuePresenceChannel = null;
    }
    if (tttSubscription) { supabaseClient.removeChannel(tttSubscription); tttSubscription = null; }
    await tttCleanupWaitingGame();
    clearTTTPendingSearchId();
    await tttRefundEntry();
    tttGame = null;
    tttEnteringGame = false;
    tttMovePending = false;
    showScreen('two-player-screen');
}


async function recoverAbandonedTTTSearch() {
    let pendingId;
    try { pendingId = localStorage.getItem(getTTTPendingSearchStorageKey()); } catch (e) { return; }
    if (!pendingId) return;
    try {
        const { data, error } = await supabaseClient.from('ttt_games').select('*').eq('id', pendingId).maybeSingle();
        if (error) return;
        if (data && data.status === 'playing') {
            clearTTTPendingSearchId();
            return;
        }
        if (!data || (data.status === 'waiting' && data.player1_name === currentName)) {
            if (data) await supabaseClient.from('ttt_games').delete().eq('id', pendingId).eq('status', 'waiting');
            currentCoins += 25;
            updateAllStatsUI();
            const saved = await syncToDatabase();
            if (!saved) return;
        }
        clearTTTPendingSearchId();
    } catch (e) {}
}

async function recoverActiveTTTGame() {
    if (!currentName || currentName === 'Guest' || currentName.startsWith('Guest.')) return;
    try {
        const first = await supabaseClient.from('ttt_games').select('*').eq('status', 'playing').eq('player1_name', currentName).order('updated_at', { ascending: false }).limit(1);
        const second = await supabaseClient.from('ttt_games').select('*').eq('status', 'playing').eq('player2_name', currentName).order('updated_at', { ascending: false }).limit(1);
        const active = (first.data && first.data[0]) || (second.data && second.data[0]);
        if (!active) return;
        tttGame = active;
        tttEntryPaid = true;
        tttEnteringGame = true;
        tttRewarded = false;
        subscribeToTTTGame(active.id);
        enterTTTGame();
    } catch (e) {}
}


async function recoverRecentTTTOutcome() {
    if (!currentName || currentName === 'Guest' || currentName.startsWith('Guest.')) return;
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const outcomes = currentName;
    const queries = [
        supabaseClient.from('ttt_games').select('*').eq('status', 'finished').eq('player1_name', outcomes).in('result', ['player1_left', 'player2_left', 'player1_timeout', 'player2_timeout']).gte('updated_at', cutoff).order('updated_at', { ascending: false }).limit(1),
        supabaseClient.from('ttt_games').select('*').eq('status', 'finished').eq('player2_name', outcomes).in('result', ['player1_left', 'player2_left', 'player1_timeout', 'player2_timeout']).gte('updated_at', cutoff).order('updated_at', { ascending: false }).limit(1)
    ];
    try {
        const results = await Promise.all(queries);
        const game = results.map(r => r.data && r.data[0]).filter(Boolean).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
        if (!game || localStorage.getItem(getTTTRewardStorageKey(game.id))) return;
        tttGame = game;
        tttEnteringGame = true;
        showScreen('online-game-screen');
        enterTTTGame();
    } catch (e) {}
}
