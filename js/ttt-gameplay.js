function subscribeToTTTGame(gameId) {
    if (!gameId) return;

    if (tttSubscription) {
        supabaseClient.removeChannel(tttSubscription);
        tttSubscription = null;
    }

    tttChannelStatus = 'CONNECTING';
    tttSubscription = supabaseClient
        .channel('ttt_game_' + gameId)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'ttt_games',
            filter: `id=eq.${gameId}`
        }, (payload) => {
            const updated = payload.new;
            if (updated && updated.id === gameId) applyTTTGameUpdate(updated);
            if (payload.eventType === 'DELETE') handleTTTGameDeleted();
        })
        .subscribe((status) => {
            tttChannelStatus = status;
            if (status === 'SUBSCRIBED') refreshTTTGame();
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                if (document.getElementById('online-search-screen')?.classList.contains('active')) {
                    updateSearchText('ارتباط زنده قطع شد؛ در حال تلاش مجدد...');
                }
            }
        });

    clearTTTSearchInterval();
    tttSearchInterval = setInterval(refreshTTTGame, 1500);
    refreshTTTGame();
}

async function refreshTTTGame() {
    if (!tttGame || !tttGame.id || tttSyncInFlight) return;
    tttSyncInFlight = true;

    try {
        const { data, error } = await supabaseClient
            .from('ttt_games')
            .select('*')
            .eq('id', tttGame.id)
            .maybeSingle();

        if (error) throw error;
        if (!data) {
            handleTTTGameDeleted();
            return;
        }
        applyTTTGameUpdate(data);
    } catch (error) {
        console.error('TTT sync error:', error);
        if (document.getElementById('online-search-screen')?.classList.contains('active')) {
            updateSearchText('مشکل اتصال؛ تلاش مجدد برای اتصال...');
        }
    } finally {
        tttSyncInFlight = false;
    }
}

function applyTTTGameUpdate(game) {
    if (!game || !tttGame || game.id !== tttGame.id) return;

    const currentTime = Date.parse(tttGame.updated_at || '');
    const incomingTime = Date.parse(game.updated_at || '');
    if (Number.isFinite(currentTime) && Number.isFinite(incomingTime) && incomingTime < currentTime) return;

    const previousKey = tttGame.updated_at + '|' + tttGame.current_turn + '|' + tttGame.status;
    const nextKey = game.updated_at + '|' + game.current_turn + '|' + game.status;
    if (previousKey === nextKey && JSON.stringify(tttGame.board) === JSON.stringify(game.board)) return;
    tttGame = game;

    const searchScreen = document.getElementById('online-search-screen');
    const gameScreen = document.getElementById('online-game-screen');
    const searchActive = !!searchScreen && searchScreen.classList.contains('active');
    const gameActive = !!gameScreen && gameScreen.classList.contains('active');

    if (tttGame.status === 'playing' && searchActive && !tttEnteringGame) {
        clearTTTSearchInterval();
        tttSearching = false;
        tttEnteringGame = true;
        enterTTTGame();
        return;
    }

    if (gameActive) {
        if (previousKey !== nextKey) {
            tttMovePending = false;
            if (tttGame.status === 'playing') startTTTTimer();
            else stopTTTTimer();
        }
        renderTTTGame();
        checkTTTGameEnd();
    }

    if (searchActive && tttGame.status === 'waiting') {
        updateSearchText('منتظر پیوستن حریف ⏳️');
    }
}

function handleTTTGameDeleted() {
    clearTTTSearchInterval();
    stopTTTTimer();
    if (tttSubscription) {
        supabaseClient.removeChannel(tttSubscription);
        tttSubscription = null;
    }
    tttGame = null;
    tttSearching = false;
    tttEnteringGame = false;
    tttMovePending = false;
    tttTimerKey = null;
    tttRefundEntry();
    if (document.getElementById('online-search-screen')?.classList.contains('active')) {
        updateSearchText('بازی جستجو شده حذف شد. دوباره تلاش کنید.');
    } else {
        showScreen('two-player-screen');
    }
}

async function fetchTTTPlayerProfiles() {
    if (!tttGame) return;
    const names = [tttGame.player1_name, tttGame.player2_name].filter(Boolean);
    if (names.length === 0) return;

    const toFetch = names.filter(name => !cachedAvatarMap[name] || cachedAvatarMap[name].custom_avatar_url === undefined || cachedAvatarMap[name].active_frame === undefined);
    if (toFetch.length === 0) return;

    const { data, error } = await supabaseClient
        .from('profiles')
        .select('name, custom_avatar_url, active_frame')
        .in('name', toFetch);

    if (error) {
        console.error('TTT profile fetch error:', error);
        return;
    }

    if (data) {
        data.forEach(profile => {
            if (!cachedAvatarMap[profile.name]) cachedAvatarMap[profile.name] = {};
            cachedAvatarMap[profile.name].custom_avatar_url = profile.custom_avatar_url;
            cachedAvatarMap[profile.name].active_frame = profile.active_frame;
        });
    }
}

function enterTTTGame() {
    clearTTTSearchInterval();
    showScreen('online-game-screen');

    const titleEl = document.getElementById('game-title-name');
    if (titleEl) titleEl.innerText = 'دوز';

    const body = document.getElementById('online-game-body');
    if (body) body.innerHTML = '';

    tttRewarded = false;
    tttMovePending = false;
    tttTimerKey = null;

    if (tttGame && tttGame.status === 'playing') startTTTTimer();
    else stopTTTTimer();

    fetchTTTPlayerProfiles().then(() => {
        if (tttGame) renderTTTGame();
    });

    if (tttGame) {
        renderTTTGame();
        checkTTTGameEnd();
    }

    if (tttGame && tttGame.id) {
        clearTTTSearchInterval();
        tttSearchInterval = setInterval(refreshTTTGame, 1500);
    }
}

function renderTTTGame() {
    const body = document.getElementById('online-game-body');
    if (!body || !tttGame) return;

    if (!document.getElementById('ttt-board')) {
        body.innerHTML = `
            <div class="ttt-container">
                <div class="ttt-info">
                    <div class="ttt-player">
                        <img class="ttt-player-avatar" id="ttt-my-avatar" src="${defaultAvatar}" alt="من">
                        <span class="ttt-player-name">من</span>
                        <span class="ttt-player-symbol" id="ttt-my-symbol"></span>
                    </div>
                    <div class="ttt-status-col">
                        <div class="ttt-status" id="ttt-status-text"></div>
                        <div class="ttt-timer" id="ttt-timer"></div>
                    </div>
                    <div class="ttt-player">
                        <img class="ttt-player-avatar" id="ttt-opp-avatar" src="${defaultAvatar}" alt="حریف">
                        <span class="ttt-player-name" id="ttt-opp-name"></span>
                        <span class="ttt-player-symbol" id="ttt-opp-symbol"></span>
                    </div>
                </div>
                <div class="ttt-board" id="ttt-board"></div>
            </div>
        `;
    }

    const isPlayer1 = tttGame.player1_name === currentName;
    const mySymbol = isPlayer1 ? tttGame.player1_symbol : tttGame.player2_symbol;
    const oppSymbol = isPlayer1 ? tttGame.player2_symbol : tttGame.player1_symbol;
    const oppName = isPlayer1 ? tttGame.player2_name : tttGame.player1_name;

    const mySymbolEl = document.getElementById('ttt-my-symbol');
    if (mySymbolEl) {
        mySymbolEl.textContent = mySymbol || '';
        mySymbolEl.className = 'ttt-player-symbol ' + String(mySymbol || '').toLowerCase();
    }

    const oppSymbolEl = document.getElementById('ttt-opp-symbol');
    if (oppSymbolEl) {
        oppSymbolEl.textContent = oppSymbol || '';
        oppSymbolEl.className = 'ttt-player-symbol ' + String(oppSymbol || '').toLowerCase();
    }

    const oppNameEl = document.getElementById('ttt-opp-name');
    if (oppNameEl) oppNameEl.textContent = oppName || 'در انتظار...';

    const myAvatarEl = document.getElementById('ttt-my-avatar');
    if (myAvatarEl) {
        myAvatarEl.src = currentCustomAvatarUrl || defaultAvatar;
        applyFrameToElement(myAvatarEl, currentFrame);
    }

    const oppAvatarEl = document.getElementById('ttt-opp-avatar');
    if (oppAvatarEl && oppName) {
        const oppProfile = cachedAvatarMap[oppName];
        oppAvatarEl.src = oppProfile && oppProfile.custom_avatar_url ? oppProfile.custom_avatar_url : defaultAvatar;
        applyFrameToElement(oppAvatarEl, oppProfile ? oppProfile.active_frame : 'none');
    }

    const statusEl = document.getElementById('ttt-status-text');
    if (statusEl) {
        if (tttGame.status === 'finished') statusEl.textContent = 'بازی تمام شد';
        else if (tttGame.status === 'waiting') statusEl.textContent = 'در انتظار...';
        else statusEl.textContent = tttGame.current_turn === currentName ? 'نوبت شماست' : 'نوبت حریف';
    }

    renderTTTBoard();
}

function renderTTTBoard() {
    const boardEl = document.getElementById('ttt-board');
    if (!boardEl || !tttGame) return;

    const board = Array.isArray(tttGame.board) && tttGame.board.length === 9 ? tttGame.board : ['', '', '', '', '', '', '', '', ''];
    const isMyTurn = tttGame.current_turn === currentName && tttGame.status === 'playing' && !tttMovePending;
    const winningCells = getTTTWinningCells(board);

    boardEl.innerHTML = '';
    board.forEach((cell, index) => {
        const cellEl = document.createElement('div');
        cellEl.className = 'ttt-cell';
        if (cell === 'X') cellEl.classList.add('x', 'filled');
        else if (cell === 'O') cellEl.classList.add('o', 'filled');
        if (winningCells.includes(index)) cellEl.classList.add('winning');
        cellEl.textContent = cell || '';
        if (isMyTurn && !cell && winningCells.length === 0) {
            cellEl.onclick = () => makeTTTMove(index);
        }
        boardEl.appendChild(cellEl);
    });
}

function getTTTWinningCells(board) {
    const lines = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ];

    for (const line of lines) {
        const [a, b, c] = line;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return line;
    }
    return [];
}

async function makeTTTMove(index) {
    if (!tttGame || tttGame.status !== 'playing') return;
    if (tttGame.current_turn !== currentName || tttMovePending) return;
    if (!Number.isInteger(index) || index < 0 || index > 8) return;

    const board = Array.isArray(tttGame.board) && tttGame.board.length === 9 ? [...tttGame.board] : ['', '', '', '', '', '', '', '', ''];
    if (board[index]) return;

    tttMovePending = true;
    renderTTTBoard();

    const gameId = tttGame.id;
    const turnStartedAt = tttGame.updated_at;
    const isPlayer1 = tttGame.player1_name === currentName;
    const mySymbol = isPlayer1 ? tttGame.player1_symbol : tttGame.player2_symbol;
    const nextTurn = isPlayer1 ? tttGame.player2_name : tttGame.player1_name;
    board[index] = mySymbol;

    const winningCells = getTTTWinningCells(board);
    const isDraw = board.every(cell => cell === 'X' || cell === 'O');
    let newStatus = 'playing';
    let result = null;

    if (winningCells.length) {
        newStatus = 'finished';
        result = isPlayer1 ? 'player1_win' : 'player2_win';
    } else if (isDraw) {
        newStatus = 'finished';
        result = 'draw';
    }

    const updateData = {
        board,
        current_turn: nextTurn,
        status: newStatus,
        updated_at: new Date().toISOString()
    };
    if (result) updateData.result = result;

    try {
        let query = supabaseClient
            .from('ttt_games')
            .update(updateData)
            .eq('id', gameId)
            .eq('current_turn', currentName)
            .eq('status', 'playing');

        if (turnStartedAt) query = query.eq('updated_at', turnStartedAt);

        const { data, error } = await query.select().maybeSingle();
        if (error) throw error;

        if (!data) {
            await refreshTTTGame();
            return;
        }

        applyTTTGameUpdate(data);
    } catch (error) {
        console.error('TTT move error:', error);
        const statusEl = document.getElementById('ttt-status-text');
        if (statusEl) statusEl.textContent = 'خطا در ثبت حرکت؛ در حال همگام‌سازی...';
        await refreshTTTGame();
    } finally {
        tttMovePending = false;
        if (tttGame && tttGame.status === 'playing') renderTTTBoard();
    }
}

function resetTTTTimer() {
    const updatedAt = tttGame && tttGame.updated_at ? new Date(tttGame.updated_at).getTime() : NaN;
    tttLocalTurnStart = Number.isFinite(updatedAt) ? updatedAt : Date.now();
    tttTimeoutFired = false;
    tttTimerKey = tttGame ? tttGame.updated_at + '|' + tttGame.current_turn + '|' + tttGame.status : null;
}

function stopTTTTimer() {
    if (tttTimerInterval) {
        clearInterval(tttTimerInterval);
        tttTimerInterval = null;
    }
    const timerEl = document.getElementById('ttt-timer');
    if (timerEl) {
        timerEl.textContent = '';
        timerEl.classList.remove('urgent');
    }
}

function startTTTTimer() {
    if (!tttGame || tttGame.status !== 'playing') {
        stopTTTTimer();
        return;
    }

    const nextKey = tttGame.updated_at + '|' + tttGame.current_turn + '|' + tttGame.status;
    if (tttTimerInterval && tttTimerKey === nextKey) return;

    stopTTTTimer();
    resetTTTTimer();

    tttTimerInterval = setInterval(() => {
        if (!tttGame || tttGame.status !== 'playing') {
            stopTTTTimer();
            return;
        }

        const elapsed = Math.floor((Date.now() - tttLocalTurnStart) / 1000);
        const remaining = Math.max(0, 15 - elapsed);
        const timerEl = document.getElementById('ttt-timer');

        if (timerEl) {
            timerEl.textContent = remaining + 's';
            if (remaining <= 5) timerEl.classList.add('urgent');
            else timerEl.classList.remove('urgent');
        }

        if (remaining <= 0 && !tttTimeoutFired) {
            tttTimeoutFired = true;
            handleTTTTimeout();
        }
    }, 200);
}

async function handleTTTTimeout() {
    if (!tttGame || tttGame.status !== 'playing' || tttMovePending) return;

    const gameId = tttGame.id;
    const turnStartedAt = tttGame.updated_at;
    const currentTurn = tttGame.current_turn;
    const isPlayer1 = currentTurn === tttGame.player1_name;
    const nextTurn = isPlayer1 ? tttGame.player2_name : tttGame.player1_name;

    if (!turnStartedAt || !nextTurn) {
        tttTimeoutFired = false;
        return;
    }

    if (Date.now() - new Date(turnStartedAt).getTime() < 15000) {
        tttTimeoutFired = false;
        return;
    }

    tttMovePending = true;

    try {
        const { data, error } = await supabaseClient
            .from('ttt_games')
            .update({
                current_turn: nextTurn,
                updated_at: new Date().toISOString()
            })
            .eq('id', gameId)
            .eq('current_turn', currentTurn)
            .eq('status', 'playing')
            .eq('updated_at', turnStartedAt)
            .select()
            .maybeSingle();

        if (error) throw error;
        if (data) {
            applyTTTGameUpdate(data);
        } else {
            await refreshTTTGame();
        }
    } catch (error) {
        console.error('TTT timeout error:', error);
        tttTimeoutFired = false;
        await refreshTTTGame();
    } finally {
        tttMovePending = false;
        if (tttGame && tttGame.status === 'playing') renderTTTBoard();
    }
            }
