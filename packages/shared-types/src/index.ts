export type UserRole = 'diner' | 'staff' | 'admin';

export type StaffRole = 'owner' | 'manager' | 'server';

export type MealSessionStatus =
  | 'open'
  | 'before_captured'
  | 'eating'
  | 'after_submitted'
  | 'scored'
  | 'pending_staff_validation'
  | 'staff_approved'
  | 'staff_rejected'
  | 'rewarded'
  | 'expired'
  | 'disputed';

export type CapturePhase = 'before' | 'after';

export type ValidationDecision = 'approved' | 'rejected' | 'adjusted';

export type ValidationReasonCode =
  | 'plate_not_clean_enough'
  | 'wrong_plate_photographed'
  | 'food_hidden_or_discarded'
  | 'image_quality_issue'
  | 'model_overestimated'
  | 'model_underestimated'
  | 'dispute_with_diner'
  | 'other';

export type FraudSignalType =
  | 'geofence_violation'
  | 'time_between_captures_too_short'
  | 'duplicate_image_hash'
  | 'image_metadata_mismatch'
  | 'score_distribution_anomaly'
  | 'velocity_anomaly'
  | 'manual_flag';

export type FraudSeverity = 'info' | 'warning' | 'block';

export type PortionSize = 'small' | 'regular' | 'large';

export interface User {
  id: string;
  email: string;
  phone?: string | null;
  display_name?: string | null;
  role: UserRole;
  email_verified_at?: string | null;
  last_login_at?: string | null;
  created_at: string;
  /** Ethics rule 6: 7 default, configurable up to 90. */
  image_retention_days: number;
}

export interface Restaurant {
  id: string;
  name: string;
  slug: string;
  address: string;
  latitude: number;
  longitude: number;
  geofence_radius_m: number;
  timezone: string;
  currency: string;
  is_active: boolean;
  theme_primary_color: string;
  theme_logo_url?: string | null;
  tagline?: string | null;
}

export interface MenuItem {
  id: string;
  restaurant_id: string;
  name: string;
  description?: string | null;
  price_minor: number;
  category?: string | null;
  is_reward_eligible: boolean;
  is_active: boolean;
  reference_image_url?: string | null;
}

export interface MealSession {
  id: string;
  diner_user_id: string;
  restaurant_id: string;
  table_code: string;
  status: MealSessionStatus;
  started_at: string;
  expires_at: string;
}

export interface PerItemScore {
  menu_item_id?: string;
  dish_name: string;
  consumption: number;
  confidence: number;
}

export interface ConsumptionScore {
  id: string;
  meal_session_id: string;
  overall_score: number;
  per_item_scores: PerItemScore[];
  model_name: string;
  model_version: string;
  processing_ms: number;
  notes?: string | null;
  suspicious?: boolean;
}

export interface StaffValidation {
  id: string;
  meal_session_id: string;
  staff_user_id: string;
  restaurant_id: string;
  decision: ValidationDecision;
  model_score: number;
  final_score: number;
  reason_code?: ValidationReasonCode | null;
  notes?: string | null;
  decided_at: string;
  decision_latency_ms: number;
}

export type RewardType = 'menu_item' | 'bill_discount';

export interface Reward {
  id: string;
  meal_session_id?: string;
  reward_rule_id?: string;
  redemption_code: string;
  reward_type: RewardType;
  value_minor: number;
  issued_at: string;
  half_value_at: string;
  expires_at: string;
  redeemed_at?: string | null;
  redeemed_value_minor?: number | null;
  voided_at?: string | null;
  voided_reason?: string | null;
  /** Server-computed value at the time of the response (full / half / 0). */
  current_value_minor?: number;
  /** Returned in the `validate` response so the diner UI can offer the type choice. */
  allowed_reward_types?: RewardType[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
