export type LinkStatus = 'pending' | 'linked';
export type RequestStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface UserRow {
  id: number;
  telegram_id: number;
  telegram_username: string | null;
  telegram_first_name: string | null;
  ig_scoped_id: string | null;
  link_code: string | null;
  link_status: LinkStatus;
  created_at: string;
  linked_at: string | null;
}

export interface RequestRow {
  id: number;
  user_id: number;
  ig_message_id: string | null;
  media_url: string;
  media_type: string | null;
  status: RequestStatus;
  attempts: number;
  next_attempt_at: string;
  locked_at: string | null;
  locked_by: string | null;
  video_file_path: string | null;
  song_title: string | null;
  song_artist: string | null;
  song_album: string | null;
  song_link: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}
