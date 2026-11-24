let rpsGame = null;
let rpsSubscription = null;
let rpsSearchInterval = null;
let rpsSearching = false;
let rpsEntryPaid = false;
let rpsRewarded = false;
let rpsMovePending = false;
let rpsLeaveConfirmOpen = false;
let rpsEnteringGame = false;

const RPS_CHOICES = {
    rock: { label: 'سنگ', icon: '✊' },
    paper: { label: 'کاغذ', icon: '✋' },
    scissors: { label: 'قیچی', icon: '✌️' }
};

function clearRPSSearchInterval() {
    if (rpsSearchInterval) {
        clearInterval(rpsSearchInterval);
        rpsSearchInterval = null;
    }
}

function rpsPayEntry() {
    if (rpsEntryPaid) return true;
    if (currentCoins < 25) return false;
    currentCoins -= 25;
    rpsEntryPaid = true;
    updateAllStatsUI();
    syncToDatabase();
    return true;
}

function rpsRefundEntry() {
    if (!rpsEntryPaid) return;
    currentCoins += 25;
    rpsEntryPaid = false;
    updateAllStatsUI();
    syncToDatabase();
}

async function rpsCleanupWaitingGame() {
    if (rpsGame && rpsGame.status === 'waiting' && rpsGame.player1_name === currentName) {
        await supabaseClient.from('rps_games').delete().eq('id', rpsGame.id);
    }
}

async function startRPSMatchmaking() {
    if (rpsSearching) return;
    rpsSearching = true;
    rpsEnteringGame = false;
    clearRPSSearchInterval();

    try {
        const { data: waitingGames, error: searchError } = await supabaseClient
            .from('rps_games')
            .select('*')
            .eq('status', 'waiting')
            .neq('player1_name', currentName)
            .order('created_at', { ascending: true })
            .limit(1);

        if (searchError) throw searchError;

        if (waitingGames && waitingGames.length) {
            const game = waitingGames[0];
            const { data, error } = await supabaseClient
                .from('rps_games')
                .update({ player2_name: currentName, status: 'playing', updated_at: new Date().toISOString() })
                .eq('id', game.id)
                .eq('status', 'waiting')
                .select()
                .maybeSingle();

            if (error) throw error;
            if (data) {
                rpsGame = data;
                subscribeToRPSGame(data.id);
                rpsSearching = false;
                enterRPSGame();
                return;
            }
        }

        const { data: created, error: createError } = await supabaseClient
            .from('rps_games')
            .insert({
                player1_name: currentName,
                status: 'waiting',
                round_number: 1,
                player1_score: 0,
                player2_score: 0,
                player1_choice: null,
                player2_choice: null,
                round_status: 'choosing',
                player1_ready: false,
                player2_ready: false
            })
            .select()
            .maybeSingle();

        if (createError || !created) throw createError || new Error('create failed');
        rpsGame = created;
        subscribeToRPSGame(created.id);

        rpsSearchInterval = setInterval(async () => {
            if (!rpsGame || rpsGame.status !== 'waiting') {
                clearRPSSearchInterval();
                return;
            }
            const { data: check } = await supabaseClient.from('rps_games').select('*').eq('id', rpsGame.id).maybeSingle();
            if (check && check.status === 'playing' && check.player2_name) {
                clearRPSSearchInterval();
                rpsGame = check;
                rpsSearching = false;
                if (document.getElementById('online-search-screen').classList.contains('active')) enterRPSGame();
            }
        }, 1000);
    } catch (error) {
        rpsSearching = false;
        rpsRefundEntry();
        updateSearchText('خطا در اتصال یا ساخت بازی. سکه برگشت داده شد.');
    }
}

function openRPSGame() {
    if (currentName === 'Guest' || currentName.startsWith('Guest.')) {
        showGuestModal();
        return;
    }
    if (currentCoins < 25 || !rpsPayEntry()) {
        openModal('no-coin-modal');
        return;
    }
    const nameEl = document.getElementById('search-game-name');
    if (nameEl) nameEl.textContent = 'سنگ کاغذ قیچی';
    updateSearchText('منتظر پیوستن حریف ⏳️');
    showScreen('online-search-screen');
    startRPSMatchmaking();
}

async function cancelRPSSearch() {
    clearRPSSearchInterval();
    if (rpsSubscription) {
        supabaseClient.removeChannel(rpsSubscription);
        rpsSubscription = null;
    }
    await rpsCleanupWaitingGame();
    rpsRefundEntry();
    rpsGame = null;
    rpsSearching = false;
    rpsEnteringGame = false;
    showScreen('two-player-screen');
}

function submitRPSChoice(choice) {
    if (!rpsGame || rpsGame.status !== 'playing' || rpsGame.round_status !== 'choosing' || rpsMovePending) return;
    if (!RPS_CHOICES[choice]) return;
    const isPlayer1 = rpsGame.player1_name === currentName;
    const ownField = isPlayer1 ? 'player1_choice' : 'player2_choice';
    if (rpsGame[ownField]) return;
    rpsMovePending = true;
    supabaseClient.from('rps_games').update({ [ownField]: choice, updated_at: new Date().toISOString() })
        .eq('id', rpsGame.id)
        .eq('status', 'playing')
        .eq('round_status', 'choosing')
        .is(ownField, null)
        .select()
        .maybeSingle()
        .then(({ data }) => {
            rpsMovePending = false;
            if (data) {
                rpsGame = data;
                renderRPSGame();
                resolveRPSRound();
            }
        });
}

function resolveRPSRound() {
    if (!rpsGame || rpsGame.round_status !== 'choosing' || !rpsGame.player1_choice || !rpsGame.player2_choice) return;
    const a = rpsGame.player1_choice;
    const b = rpsGame.player2_choice;
    let winner = 'draw';
    if (a !== b) {
        winner = (a === 'rock' && b === 'scissors') || (a === 'paper' && b === 'rock') || (a === 'scissors' && b === 'paper') ? 'player1' : 'player2';
    }
    const update = {
        round_status: 'revealed',
        round_result: winner,
        player1_score: rpsGame.player1_score + (winner === 'player1' ? 1 : 0),
        player2_score: rpsGame.player2_score + (winner === 'player2' ? 1 : 0),
        status: (rpsGame.player1_score + (winner === 'player1' ? 1 : 0) >= 3 || rpsGame.player2_score + (winner === 'player2' ? 1 : 0) >= 3) ? 'finished' : 'playing',
        updated_at: new Date().toISOString()
    };
    supabaseClient.from('rps_games').update(update)
        .eq('id', rpsGame.id)
        .eq('round_status', 'choosing')
        .not('player1_choice', 'is', null)
        .not('player2_choice', 'is', null)
        .select()
        .maybeSingle()
        .then(({ data }) => {
            if (data) {
                rpsGame = data;
                renderRPSGame();
                checkRPSGameEnd();
            }
        });
}

async function readyForNextRPSRound() {
    if (!rpsGame || rpsGame.status !== 'playing' || rpsGame.round_status !== 'revealed') return;
    const isPlayer1 = rpsGame.player1_name === currentName;
    const ownField = isPlayer1 ? 'player1_ready' : 'player2_ready';
    const { data } = await supabaseClient.from('rps_games').update({ [ownField]: true }).eq('id', rpsGame.id).eq('round_status', 'revealed').select().maybeSingle();
    if (data) rpsGame = data;
    renderRPSGame();
    if (rpsGame.player1_ready && rpsGame.player2_ready) {
        const { data: next } = await supabaseClient.from('rps_games').update({
            round_number: rpsGame.round_number + 1,
            player1_choice: null,
            player2_choice: null,
            round_result: null,
            round_status: 'choosing',
            player1_ready: false,
            player2_ready: false,
            updated_at: new Date().toISOString()
        }).eq('id', rpsGame.id).eq('round_status', 'revealed').eq('player1_ready', true).eq('player2_ready', true).select().maybeSingle();
        if (next) rpsGame = next;
        renderRPSGame();
    }
}
