// TypeScript source type declarations for shop seat selector.
type SeatStatus = "available" | "hold" | "sold" | "blocked" | "technical";

type ShopSeat = {
  id: number | string;
  external_id: string;
  x: number;
  y: number;
  row_label: string;
  seat_number: string;
};

export type { SeatStatus, ShopSeat };

