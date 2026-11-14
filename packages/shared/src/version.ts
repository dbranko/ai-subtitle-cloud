/** Application name and version reported by every service's health endpoint. */
export const APP_NAME = 'ai-subtitle-cloud';
export const APP_VERSION = '0.1.0';

export const SERVICE_NAMES = ['api', 'worker', 'addon'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];
