import { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from '@/components/Explore/types';

type LocalPoolsResponse = {
    pools: Pool[];
};

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<LocalPoolsResponse | { error: string }>
) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Return empty array - Jupiter API handles showing your tokens
        res.status(200).json({
            pools: [],
        });
    } catch (error) {
        console.error('Local pools error:', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
}
