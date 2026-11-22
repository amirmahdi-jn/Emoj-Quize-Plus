ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS sender_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.private_messages
ADD COLUMN IF NOT EXISTS sender_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS receiver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.friend_requests
ADD COLUMN IF NOT EXISTS sender_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS receiver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.ttt_games
ADD COLUMN IF NOT EXISTS player1_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS player2_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_sender_id_idx
ON public.messages (sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS private_messages_sender_id_idx
ON public.private_messages (sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS private_messages_receiver_id_idx
ON public.private_messages (receiver_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS friend_requests_sender_id_idx
ON public.friend_requests (sender_id, status);

CREATE INDEX IF NOT EXISTS friend_requests_receiver_id_idx
ON public.friend_requests (receiver_id, status);

CREATE INDEX IF NOT EXISTS ttt_games_player1_id_idx
ON public.ttt_games (player1_id, status);

CREATE INDEX IF NOT EXISTS ttt_games_player2_id_idx
ON public.ttt_games (player2_id, status);
