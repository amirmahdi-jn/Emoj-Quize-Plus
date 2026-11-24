function subscribeToRPSGame(gameId) {
    if (rpsSubscription) supabaseClient.removeChannel(rpsSubscription);
    rpsSubscription = supabaseClient.channel('rps_game_' + gameId)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rps_games', filter: `id=eq.${gameId}` }, payload => {
            if (!payload.new) return;
            rpsGame = payload.new;
            const searchActive = document.getElementById('online-search-screen').classList.contains('active');
            const gameActive = document.getElementById('online-game-screen').classList.contains('active');
            if (rpsGame.status === 'playing' && searchActive && !rpsEnteringGame) {
                clearRPSSearchInterval();
                rpsSearching = false;
                enterRPSGame();
            } else if (gameActive) {
                renderRPSGame();
                resolveRPSRound();
                checkRPSGameEnd();
            }
        }).subscribe();
}

async function fetchRPSPlayerProfiles() {
    if (!rpsGame) return;
    const names = [rpsGame.player1_name, rpsGame.player2_name].filter(Boolean);
    const missing = names.filter(name => !cachedAvatarMap[name] || cachedAvatarMap[name].custom_avatar_url === undefined || cachedAvatarMap[name].active_frame === undefined);
    if (!missing.length) return;
    const { data } = await supabaseClient.from('profiles').select('name, custom_avatar_url, active_frame').in('name', missing);
    if (data) data.forEach(profile => {
        if (!cachedAvatarMap[profile.name]) cachedAvatarMap[profile.name] = {};
        cachedAvatarMap[profile.name].custom_avatar_url = profile.custom_avatar_url;
        cachedAvatarMap[profile.name].active_frame = profile.active_frame;
    });
}

function enterRPSGame() {
    clearRPSSearchInterval();
    rpsEnteringGame = true;
    showScreen('online-game-screen');
    const title = document.getElementById('game-title-name');
    if (title) title.textContent = 'سنگ کاغذ قیچی';
    rpsRewarded = false;
    rpsMovePending = false;
    fetchRPSPlayerProfiles().then(renderRPSGame);
    renderRPSGame();
}

function renderRPSGame() {
    const body = document.getElementById('online-game-body');
    if (!body || !rpsGame) return;
    if (!document.getElementById('rps-arena')) {
        body.innerHTML = `
            <div class="rps-container" id="rps-arena">
                <div class="rps-scoreboard">
                    <div class="rps-player-card"><img id="rps-my-avatar" src="${defaultAvatar}" alt="من"><strong id="rps-my-name"></strong><span id="rps-my-score">0</span></div>
                    <div class="rps-versus"><span>VS</span><small id="rps-round-number">دور ۱</small></div>
                    <div class="rps-player-card"><img id="rps-opp-avatar" src="${defaultAvatar}" alt="حریف"><strong id="rps-opp-name"></strong><span id="rps-opp-score">0</span></div>
                </div>
                <div class="rps-timer" id="rps-timer">10</div>
                <div class="rps-choices" id="rps-choices"></div>
            </div>`;
    }
    const isPlayer1 = rpsGame.player1_name === currentName;
    const myName = isPlayer1 ? rpsGame.player1_name : rpsGame.player2_name;
    const oppName = isPlayer1 ? rpsGame.player2_name : rpsGame.player1_name;
    const myScore = isPlayer1 ? rpsGame.player1_score : rpsGame.player2_score;
    const oppScore = isPlayer1 ? rpsGame.player2_score : rpsGame.player1_score;
    const myChoice = isPlayer1 ? rpsGame.player1_choice : rpsGame.player2_choice;
    const oppChoice = isPlayer1 ? rpsGame.player2_choice : rpsGame.player1_choice;
    const myReady = isPlayer1 ? rpsGame.player1_ready : rpsGame.player2_ready;
    const oppReady = isPlayer1 ? rpsGame.player2_ready : rpsGame.player1_ready;
    const myAvatar = document.getElementById('rps-my-avatar');
    const oppAvatar = document.getElementById('rps-opp-avatar');
    const oppProfile = cachedAvatarMap[oppName];
    if (myAvatar) { myAvatar.src = currentCustomAvatarUrl || defaultAvatar; applyFrameToElement(myAvatar, currentFrame); }
    if (oppAvatar) { oppAvatar.src = oppProfile && oppProfile.custom_avatar_url ? oppProfile.custom_avatar_url : defaultAvatar; applyFrameToElement(oppAvatar, oppProfile ? oppProfile.active_frame : 'none'); }
    document.getElementById('rps-my-name').textContent = myName || 'من';
    document.getElementById('rps-opp-name').textContent = oppName || 'در انتظار حریف';
    document.getElementById('rps-my-score').textContent = myScore;
    document.getElementById('rps-opp-score').textContent = oppScore;
    document.getElementById('rps-round-number').textContent = `دور ${rpsGame.round_number}`;
    const choices = document.getElementById('rps-choices');
    const timer = document.getElementById('rps-timer');
    if (rpsGame.round_status === 'choosing') {
        choices.innerHTML = Object.entries(RPS_CHOICES).map(([key, item]) => `<button class="rps-choice" onclick="submitRPSChoice('${key}')" ${myChoice ? 'disabled' : ''}><span>${item.icon}</span><strong>${item.label}</strong></button>`).join('');
        const startedAt = new Date(rpsGame.updated_at).getTime();
        if (timer) timer.textContent = Math.max(0, 10 - Math.floor((Date.now() - startedAt) / 1000));
        startRPSRoundTimer();
    } else {
        clearRPSRoundTimer();
        if (timer) timer.textContent = '0';
        choices.innerHTML = '';
    }
    if (rpsGame.status === 'finished') checkRPSGameEnd();
}
