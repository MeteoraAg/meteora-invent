import { Tx } from '@/components/Explore/types';
import { Pool } from '../types';

export type StreamRequest =
  | {
      type: 'subscribe:pool' | 'unsubscribe:pool';
      pools: string[];
    }
  | {
      type: 'subscribe:txns' | 'unsubscribe:txns';
      assets: string[];
    }
  | {
      type: 'subscribe:recent' | 'unsubscribe:recent';
      filters?: {
        partnerConfigs: string[];
      };
    }
  | {
      type: 'subscribe:prices' | 'unsubscribe:prices';
      assets: string[];
    };

type StreamUpdatesResponse = {
  type: 'updates';
  data: {
    type: 'new' | 'update' | 'graduated';
    pool: Pool;
  }[];
};

type StreamActionsResponse = {
  type: 'actions';
  data: Tx[];
};

type StreamAssetPricesResponse = {
  type: 'prices';
  data: {
    blockId: number;
    assetId: string;
    price: number;
  }[];
};

export type StreamResponse =
  StreamUpdatesResponse | StreamActionsResponse | StreamAssetPricesResponse;

export function createRequest(req: StreamRequest): string {
  return JSON.stringify(req);
}
