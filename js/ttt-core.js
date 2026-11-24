let tttGame = null;
let tttSubscription = null;
let tttTimerInterval = null;
let tttEnteringGame = false;
let tttLocalTurnStart = 0;
let tttTimeoutFired = false;
let tttLeaveConfirmOpen = false;
let tttRewarded = false;
let tttMovePending = false;
let tttSearchInterval = null;
let tttSearching = false;
let tttEntryPaid = false;
let tttSyncInFlight = false;
let tttTimerKey = null;
let tttChannelStatus = 'CLOSED';
let tttCancelInProgress = false;
let tttMatchmakingToken = 0;

const TTT_TROPHY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`;
const TTT_COIN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f1c40f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>`;

function clearTTTSearchInterval() {
    if (tttSearchInterval) {
        clearInterval(tttSearchInterval);
        tttSearchInterval = null;
    }
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

function tttRefundEntry() {
    if (!tttEntryPaid) return;
    currentCoins += 25;
    tttEntryPaid = false;
    updateAllStatsUI();
    syncToDatabase();
}

async function tttCleanupWaitingGame() {
    if (!tttGame || !tttGame.id) return { removed: false, game: null, error: null };

    const gameId = tttGame.id;
    const { data: deleted, error: deleteError } = await supabaseClient
        .from('ttt_games')
        .delete()
        .eq('id', gameId)
        .eq('player1_name', currentName)
        .eq('status', 'waiting')
        .select('id')
        .maybeSingle();

    if (deleteError) return { removed: false, game: null, error: deleteError };
    if (deleted) return { removed: true, game: null, error: null };

    const { data: latest, error: fetchError } = await supabaseClient
        .from('ttt_games')
        .select('*')
        .eq('id', gameId)
        .maybeSingle();

    if (fetchError) return { removed: false, game: null, error: fetchError };
    return { removed: false, game: latest || null, error: null };
}

function updateSearchText(text) {
    const el = document.getElementById('search-status-text');
    if (el) el.textContent = text;
}

async function startTTTMatchmaking() {
    if (tttSearching || tttCancelInProgress) return;

    tttSearching = true;
    const matchmakingToken = ++tttMatchmakingToken;
    tttEnteringGame = false;
    tttMovePending = false;
    clearTTTSearchInterval();
    updateSearchText('در حال جستجوی حریف...');

    try {
        const cutoff = new Date(Date.now() - 60000).toISOString();
        const { data: waitingGames, error: searchError } = await supabaseClient
            .from('ttt_games')
            .select('*')
            .eq('status', 'waiting')
            .neq('player1_name', currentName)
            .gte('created_at', cutoff)
            .order('created_at', { ascending: true })
            .limit(1);

        if (searchError) throw searchError;
        if (matchmakingToken !== tttMatchmakingToken) return;

        if (waitingGames && waitingGames.length > 0) {
            const game = waitingGames[0];
            const mySymbol = game.player1_symbol === 'X' ? 'O' : 'X';
            const { data, error: joinError } = await supabaseClient
                .from('ttt_games')
                .update({
                    player2_name: currentName,
                    player2_symbol: mySymbol,
                    status: 'playing',
                    current_turn: game.player1_name,
                    updated_at: new Date().toISOString()
                })
                .eq('id', game.id)
                .eq('status', 'waiting')
                .is('player2_name', null)
                .select()
                .maybeSingle();

            if (joinError) throw joinError;
            if (matchmakingToken !== tttMatchmakingToken) return;

            if (data) {
                tttGame = data;
                tttSearching = false;
                subscribeToTTTGame(data.id);
                if (!tttEnteringGame) {
                    tttEnteringGame = true;
                    enterTTTGame();
                }
                return;
            }
        }

        const mySymbol = Math.random() < 0.5 ? 'X' : 'O';
        const { data: created, error: createError } = await supabaseClient
            .from('ttt_games')
            .insert({
                player1_name: currentName,
                player1_symbol: mySymbol,
                player2_symbol: mySymbol === 'X' ? 'O' : 'X',
                current_turn: currentName,
                status: 'waiting',
                board: ['', '', '', '', '', '', '', '', '']
            })
            .select()
            .maybeSingle();

        if (createError || !created) throw createError || new Error('Game creation failed');
        if (matchmakingToken !== tttMatchmakingToken) {
            await supabaseClient.from('ttt_games').delete().eq('id', created.id).eq('player1_name', currentName).eq('status', 'waiting');
            return;
        }

        tttGame = created;
        subscribeToTTTGame(created.id);
        updateSearchText('منتظر پیوستن حریف ⏳️');
    } catch (error) {
        if (matchmakingToken !== tttMatchmakingToken) return;
        tttSearching = false;
        tttRefundEntry();
        updateSearchText('خطا در اتصال یا ساخت بازی. دوباره تلاش کنید.');
        console.error('TTT matchmaking error:', error);
    }
}

function openOnlineGame(gameType) {
    if (gameType === 'rps') {
        openRPSGame();
        return;
    }
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
    if (rpsSearching || rpsGame || document.getElementById('search-game-name')?.textContent === 'سنگ کاغذ قیچی') {
        await cancelRPSSearch();
        return;
    }

    if (tttCancelInProgress) return;
    tttCancelInProgress = true;
    tttMatchmakingToken++;
    clearTTTSearchInterval();

    if (tttGame && tttGame.id) {
        const cleanup = await tttCleanupWaitingGame();
        if (cleanup.error) {
            tttCancelInProgress = false;
            updateSearchText('قطع ارتباط با سرور. دوباره تلاش کنید.');
            return;
        }

        if (cleanup.removed) {
            tttRefundEntry();
        } else if (cleanup.game && cleanup.game.status === 'playing') {
            tttGame = cleanup.game;
            tttCancelInProgress = false;
            await leaveTTTGame();
            return;
        } else if (cleanup.game && cleanup.game.status === 'finished') {
            tttGame = cleanup.game;
        } else if (tttGame.status === 'waiting') {
            tttCancelInProgress = false;
            updateSearchText('بازی هنوز در سرور ثبت است. دوباره انصراف را بزنید.');
            return;
        }
    } else {
        tttRefundEntry();
    }

    if (tttSubscription) {
        await supabaseClient.removeChannel(tttSubscription);
        tttSubscription = null;
    }

    tttGame = null;
    tttEnteringGame = false;
    tttMovePending = false;
    tttSearching = false;
    tttCancelInProgress = false;
    tttTimerKey = null;
    showScreen('two-player-screen');
        }
