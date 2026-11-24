let rpsGame = null;
let rpsSubscription = null;
let rpsSearchInterval = null;
let rpsSearching = false;
let rpsEntryPaid = false;
let rpsRewarded = false;
let rpsMovePending = false;
let rpsLeaveConfirmOpen = false;
let rpsEnteringGame = false;
let rpsRoundTimer = null;
let rpsTimeoutPending = false;

const RPS_CHOICES = {
    rock: { label: 'سنگ', icon: '✊' },
    paper: { label: 'کاغذ', icon: '✋' },
    scissors: { label: 'قیچی', icon: '✌️' }
};

function clearRPSRoundTimer() {
    if (rpsRoundTimer) {
        clearInterval(rpsRoundTimer);
        rpsRoundTimer = null;
    }
}

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
    if (!rpsGame || !rpsGame.id) return { removed: false, game: null, error: null };
    if (rpsGame.status !== 'waiting' || rpsGame.player1_name !== currentName) {
        return { removed: false, game: rpsGame, error: null };
    }

    const gameId = rpsGame.id;
    const { data: deleted, error: deleteError } = await supabaseClient
        .from('rps_games')
        .delete()
        .eq('id', gameId)
        .eq('player1_name', currentName)
        .eq('status', 'waiting')
        .select('id')
        .maybeSingle();

    if (deleteError) return { removed: false, game: null, error: deleteError };
    if (deleted) return { removed: true, game: null, error: null };

    const { data: latest, error: fetchError } = await supabaseClient
        .from('rps_games')
        .select('*')
        .eq('id', gameId)
        .maybeSingle();

    if (fetchError) return { removed: false, game: null, error: fetchError };
    return { removed: false, game: latest || null, error: null };
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
    if (!rpsSearching && !rpsGame) return;
    clearRPSSearchInterval();

    if (rpsGame && rpsGame.id && rpsGame.status === 'waiting') {
        const cleanup = await rpsCleanupWaitingGame();
        if (cleanup.error) {
            updateSearchText('ارتباط با سرور برقرار نشد. دوباره تلاش کنید.');
            return;
        }
        if (cleanup.removed) {
            rpsRefundEntry();
        } else if (cleanup.game && cleanup.game.status === 'playing') {
            rpsGame = cleanup.game;
            rpsSearching = false;
            if (rpsSubscription) {
                await supabaseClient.removeChannel(rpsSubscription);
                rpsSubscription = null;
            }
            enterRPSGame();
            return;
        } else if (cleanup.game && cleanup.game.status === 'finished') {
            rpsGame = cleanup.game;
        } else if (cleanup.game && cleanup.game.status === 'waiting') {
            updateSearchText('بازی هنوز در سرور ثبت است. دوباره انصراف را بزنید.');
            return;
        }
    } else if (!rpsGame) {
        rpsRefundEntry();
    }

    if (rpsSubscription) {
        await supabaseClient.removeChannel(rpsSubscription);
        rpsSubscription = null;
    }
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
    supabaseClient.from('rps_games').update({ [ownField]: choice })
        .eq('id', rpsGame.id)
        .eq('status', 'playing')
        .eq('round_status', 'choosing')
        .eq('updated_at', rpsGame.updated_at)
        .is(ownField, null)
        .select()
        .maybeSingle()
        .then(async ({ data, error }) => {
            if (error) throw error;
            if (data) {
                rpsGame = data;
                renderRPSGame();
                resolveRPSRound();
            } else {
                await refreshRPSGame();
            }
        })
        .catch(async error => {
            console.error('RPS move error:', error);
            updateSearchText('خطا در ثبت حرکت؛ در حال همگام‌سازی...');
            await refreshRPSGame();
        })
        .finally(() => {
            rpsMovePending = false;
            if (rpsGame && rpsGame.status === 'playing') renderRPSGame();
        });
}

function resolveRPSRound() {
    if (!rpsGame || rpsGame.status !== 'playing' || rpsGame.round_status !== 'choosing' || !rpsGame.player1_choice || !rpsGame.player2_choice) return;
    const a = rpsGame.player1_choice;
    const b = rpsGame.player2_choice;
    let winner = 'draw';
    if (a !== b) {
        winner = (a === 'rock' && b === 'scissors') || (a === 'paper' && b === 'rock') || (a === 'scissors' && b === 'paper') ? 'player1' : 'player2';
    }
    advanceRPSRound(winner, rpsGame.updated_at);
}

async function advanceRPSRound(winner, roundStartedAt) {
    if (!rpsGame || rpsTimeoutPending || rpsGame.status !== 'playing') return;
    rpsTimeoutPending = true;
    const player1Score = rpsGame.player1_score + (winner === 'player1' ? 1 : 0);
    const player2Score = rpsGame.player2_score + (winner === 'player2' ? 1 : 0);
    const finished = player1Score >= 3 || player2Score >= 3;
    const update = finished ? {
        player1_score: player1Score,
        player2_score: player2Score,
        status: 'finished',
        round_status: 'revealed',
        round_result: winner,
        updated_at: new Date().toISOString()
    } : {
        player1_score: player1Score,
        player2_score: player2Score,
        round_number: rpsGame.round_number + (winner === 'draw' ? 0 : 1),
        player1_choice: null,
        player2_choice: null,
        round_result: null,
        round_status: 'choosing',
        player1_ready: false,
        player2_ready: false,
        updated_at: new Date().toISOString()
    };
    let query = supabaseClient.from('rps_games').update(update).eq('id', rpsGame.id).eq('status', 'playing').eq('round_status', 'choosing');
    if (roundStartedAt) query = query.eq('updated_at', roundStartedAt);
    query = rpsGame.player1_choice ? query.eq('player1_choice', rpsGame.player1_choice) : query.is('player1_choice', null);
    query = rpsGame.player2_choice ? query.eq('player2_choice', rpsGame.player2_choice) : query.is('player2_choice', null);
    try {
        const { data, error } = await query.select().maybeSingle();
        if (error) throw error;
        if (data) rpsGame = data;
        else await refreshRPSGame();
    } catch (error) {
        console.error('RPS round update error:', error);
        await refreshRPSGame();
    }
    rpsTimeoutPending = false;
    if (rpsGame && rpsGame.status === 'finished') checkRPSGameEnd();
    else renderRPSGame();
}

function startRPSRoundTimer() {
    clearRPSRoundTimer();
    rpsRoundTimer = setInterval(async () => {
        if (!rpsGame || rpsGame.status !== 'playing' || rpsGame.round_status !== 'choosing') return;
        const timer = document.getElementById('rps-timer');
        const startedAt = new Date(rpsGame.updated_at).getTime();
        const remaining = Math.max(0, 10 - Math.floor((Date.now() - startedAt) / 1000));
        if (timer) timer.textContent = remaining;
        if (Date.now() - startedAt < 10000 || rpsTimeoutPending) return;
        const p1 = rpsGame.player1_choice;
        const p2 = rpsGame.player2_choice;
        if (p1 && p2) {
            resolveRPSRound();
            return;
        }
        if (!p1 && !p2) {
            rpsTimeoutPending = true;
            const { data } = await supabaseClient.from('rps_games').update({
                player1_choice: null,
                player2_choice: null,
                updated_at: new Date().toISOString()
            }).eq('id', rpsGame.id).eq('status', 'playing').eq('round_status', 'choosing').eq('updated_at', rpsGame.updated_at).is('player1_choice', null).is('player2_choice', null).select().maybeSingle();
            if (data) rpsGame = data;
            rpsTimeoutPending = false;
            renderRPSGame();
            return;
        }
        await advanceRPSRound(p1 ? 'player1' : 'player2', rpsGame.updated_at);
    }, 200);
}

