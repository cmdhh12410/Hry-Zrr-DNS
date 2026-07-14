import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';

export function registerHealthRoutes(router: Router) {
  router.get('/health', async () => {
    return successResponse({ status: 'ok', timestamp: new Date().toISOString() });
  });
}