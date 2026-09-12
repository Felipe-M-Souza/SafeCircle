import type { LiveLocationPoint } from "../lib/api";

export interface LiveLocationMapProps {
  latest: LiveLocationPoint | null;
  /** Trilha recente (limitada), em ordem cronológica. */
  trail: LiveLocationPoint[];
  stale: boolean;
}

/**
 * Mapa da localização ao vivo. Implementações por plataforma:
 * `LiveLocationMap.native.tsx` (react-native-maps) e `LiveLocationMap.web.tsx`
 * (placeholder). O domínio não depende do provedor de mapas.
 */
export function LiveLocationMap(props: LiveLocationMapProps): React.JSX.Element;
