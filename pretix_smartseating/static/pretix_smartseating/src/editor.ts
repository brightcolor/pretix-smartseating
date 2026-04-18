// TypeScript source mirroring static/js/editor.js for build pipelines.
type Seat = {
  external_id: string;
  x: number;
  y: number;
  row_label: string;
  seat_number: string;
  seat_index: number;
  row_index: number;
  category_code: string;
  is_blocked: boolean;
};

type EditorState = {
  seats: Seat[];
  categories: Array<{ code: string; name: string; color: string; price_rank: number }>;
  bounds: { width: number; height: number };
  plan: { width: number; height: number; grid_size: number; snap_enabled: boolean };
};

export type { Seat, EditorState };

