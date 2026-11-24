function checkRPSGameEnd() {
    if (!rpsGame || rpsGame.status !== 'finished' || document.getElementById('rps-result-overlay')) return;
    const isPlayer1 = rpsGame.player1_name === currentName;
    const iWon = (rpsGame.player1_score >= 3 && isPlayer1) || (rpsGame.player2_score >= 3 && !isPlayer1);
    const title = iWon ? 'بردی! 😃' : 'باختی! ☹️';
    const color = iWon ? '#22c55e' : '#f87171';
    const body = iWon
        ? `<div class="ttt-achievement-row"><span class="ttt-achievement-num">+10</span><span class="ttt-achievement-icon">${TTT_TROPHY_ICON}</span></div><div class="ttt-achievement-row"><span class="ttt-achievement-num">+50</span><span class="ttt-achievement-icon">${TTT_COIN_ICON}</span></div>`
        : `<div class="ttt-achievement-row"><span class="ttt-achievement-num">-5</span><span class="ttt-achievement-icon">${TTT_TROPHY_ICON}</span></div>`;
    if (!rpsRewarded) {
        rpsRewarded = true;
        if (iWon) {
            currentTrophies += 10;
            currentCoins += 50;
        } else {
            currentTrophies = Math.max(0, currentTrophies - 5);
        }
        updateAllStatsUI();
        syncToDatabase();
    }
    const overlay = document.createElement('div');
    overlay.className = 'ttt-result-overlay';
    overlay.id = 'rps-result-overlay';
    overlay.innerHTML = `<div class="ttt-result-content"><div class="ttt-result-title" style="color:${color}">${title}</div><div class="rps-final-score">${rpsGame.player1_score} - ${rpsGame.player2_score}</div>${body}<div class="ttt-result-buttons"><button class="ttt-result-btn secondary" onclick="exitRPSGame()">خروج</button></div></div>`;
    document.body.appendChild(overlay);
}

function exitRPSGame() {
    const overlay = document.getElementById('rps-result-overlay');
    if (overlay) overlay.remove();
    cleanupRPSGame();
}

async function cleanupRPSGame() {
    clearRPSSearchInterval();
    clearRPSRoundTimer();
    if (rpsSubscription) {
        supabaseClient.removeChannel(rpsSubscription);
        rpsSubscription = null;
    }
    const modal = document.getElementById('leave-game-modal');
    if (modal) modal.classList.remove('active');
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen) activeScreen.classList.remove('blurred');
    rpsGame = null;
    rpsSearching = false;
    rpsEntryPaid = false;
    rpsRewarded = false;
    rpsMovePending = false;
    rpsEnteringGame = false;
    rpsLeaveConfirmOpen = false;
    showScreen('two-player-screen');
}

async function leaveRPSGame() {
    if (rpsGame && rpsGame.status === 'waiting') await rpsCleanupWaitingGame();
    if (rpsGame && rpsGame.status === 'playing') {
        const isPlayer1 = rpsGame.player1_name === currentName;
        await supabaseClient.from('rps_games').update({ status: 'finished', result: isPlayer1 ? 'player2_win' : 'player1_win', player1_score: isPlayer1 ? 0 : 3, player2_score: isPlayer1 ? 3 : 0, updated_at: new Date().toISOString() }).eq('id', rpsGame.id).eq('status', 'playing');
        if (!rpsRewarded) {
            rpsRewarded = true;
            currentTrophies = Math.max(0, currentTrophies - 5);
            updateAllStatsUI();
            syncToDatabase();
        }
    }
    await cleanupRPSGame();
}
