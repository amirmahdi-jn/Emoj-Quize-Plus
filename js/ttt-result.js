function checkTTTGameEnd() {
    if (!tttGame || tttGame.status !== 'finished' || document.getElementById('ttt-result-overlay')) return;

    const isPlayer1 = tttGame.player1_name === currentName;
    const iWon = (tttGame.result === 'player1_win' && isPlayer1) || (tttGame.result === 'player2_win' && !isPlayer1);
    const isDraw = tttGame.result === 'draw';
    const title = isDraw ? 'مساوی شد! 🤝' : iWon ? 'بردی! 😃' : 'باختی! ☹️';
    const resultClass = isDraw ? 'draw' : iWon ? 'win' : 'lose';

    if (tttTimerInterval) {
        clearInterval(tttTimerInterval);
        tttTimerInterval = null;
    }

    const overlay = document.createElement('div');
    overlay.className = 'ttt-result-overlay';
    overlay.id = 'ttt-result-overlay';
    overlay.innerHTML = `<div class="ttt-result-content"><div class="ttt-result-title ${resultClass}">${title}</div><div class="ttt-result-buttons"><button class="ttt-result-btn secondary" onclick="exitTTTGame()">خروج</button></div></div>`;
    document.body.appendChild(overlay);
}

function confirmLeaveGame() {
    if (!tttGame && !rpsGame) return;
    const modal = document.getElementById('leave-game-modal');
    if (!modal) return;
    if (tttGame) tttLeaveConfirmOpen = true;
    if (rpsGame) rpsLeaveConfirmOpen = true;
    modal.classList.add('active');
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen) activeScreen.classList.add('blurred');
}

function closeLeaveGameModal() {
    const modal = document.getElementById('leave-game-modal');
    if (modal) modal.classList.remove('active');
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen) activeScreen.classList.remove('blurred');
    if (typeof tttLeaveConfirmOpen !== 'undefined') tttLeaveConfirmOpen = false;
    if (typeof rpsLeaveConfirmOpen !== 'undefined') rpsLeaveConfirmOpen = false;
}

async function confirmLeaveGameYes() {
    closeLeaveGameModal();
    if (typeof rpsGame !== 'undefined' && rpsGame) {
        await leaveRPSGame();
        return;
    }
    if (typeof tttGame !== 'undefined' && tttGame) {
        await leaveTTTGame();
    }
}

async function leaveTTTGame() {
    if (!tttGame) return;

    if (tttGame.status === 'waiting') {
        await tttCleanupWaitingGame();
        tttRefundEntry();
        await cleanupTTTGame();
        return;
    }

    if (tttGame.status === 'playing') {
        const gameId = tttGame.id;
        const isPlayer1 = tttGame.player1_name === currentName;
        const result = isPlayer1 ? 'player2_win' : 'player1_win';
        const { data, error } = await supabaseClient
            .from('ttt_games')
            .update({
                status: 'finished',
                result,
                updated_at: new Date().toISOString()
            })
            .eq('id', gameId)
            .eq('status', 'playing')
            .select()
            .maybeSingle();

        if (error || !data) return;

        tttGame = data;
        if (!tttRewarded) {
            tttRewarded = true;
            currentTrophies = Math.max(0, currentTrophies - 5);
            updateAllStatsUI();
            syncToDatabase();
        }
    }

    await cleanupTTTGame();
}

function exitTTTGame() {
    const overlay = document.getElementById('ttt-result-overlay');
    if (overlay) overlay.remove();
    cleanupTTTGame();
}

async function cleanupTTTGame() {
    if (tttTimerInterval) {
        clearInterval(tttTimerInterval);
        tttTimerInterval = null;
    }

    clearTTTSearchInterval();

    if (tttSubscription) {
        supabaseClient.removeChannel(tttSubscription);
        tttSubscription = null;
    }

    const modal = document.getElementById('leave-game-modal');
    if (modal) modal.classList.remove('active');

    const resultOverlay = document.getElementById('ttt-result-overlay');
    if (resultOverlay) resultOverlay.remove();

    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen) activeScreen.classList.remove('blurred');

    tttGame = null;
    tttSearching = false;
    tttEnteringGame = false;
    tttMovePending = false;
    tttTimeoutFired = false;
    tttLeaveConfirmOpen = false;
    tttRewarded = false;
    tttEntryPaid = false;

    showScreen('two-player-screen');
}
