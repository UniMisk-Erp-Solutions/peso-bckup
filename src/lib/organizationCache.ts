// Utility functions for caching organization data in browser localStorage
// This allows showing organization logos on the login page before authentication

const CACHE_KEY_PREFIX = 'pesowise_org_cache_';
const CACHE_EXPIRY_DAYS = 30; // Cache expires after 30 days

interface CachedOrganization {
  id: string;
  name: string;
  logo_url: string | null;
  cached_at: string; // ISO timestamp
  email: string; // Email used to cache this
}

/**
 * Cache organization data for a specific email
 */
export function cacheOrganization(email: string, organization: { id: string; name: string; logo_url: string | null }) {
  try {
    const cacheKey = `${CACHE_KEY_PREFIX}${email.toLowerCase()}`;
    const cachedData: CachedOrganization = {
      ...organization,
      cached_at: new Date().toISOString(),
      email: email.toLowerCase()
    };
    localStorage.setItem(cacheKey, JSON.stringify(cachedData));
    console.log('✅ Cached organization data for:', email);
  } catch (error) {
    console.error('Error caching organization:', error);
  }
}

/**
 * Get cached organization data for a specific email
 */
export function getCachedOrganization(email: string): CachedOrganization | null {
  try {
    if (!email) return null;
    
    const cacheKey = `${CACHE_KEY_PREFIX}${email.toLowerCase()}`;
    const cached = localStorage.getItem(cacheKey);
    
    if (!cached) return null;
    
    const data: CachedOrganization = JSON.parse(cached);
    
    // Check if cache is expired
    const cachedDate = new Date(data.cached_at);
    const now = new Date();
    const daysDiff = (now.getTime() - cachedDate.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysDiff > CACHE_EXPIRY_DAYS) {
      // Cache expired, remove it
      localStorage.removeItem(cacheKey);
      console.log('⚠️ Cached organization data expired for:', email);
      return null;
    }
    
    return data;
  } catch (error) {
    console.error('Error reading cached organization:', error);
    return null;
  }
}

/**
 * Clear cached organization data for a specific email
 */
export function clearCachedOrganization(email: string) {
  try {
    const cacheKey = `${CACHE_KEY_PREFIX}${email.toLowerCase()}`;
    localStorage.removeItem(cacheKey);
    console.log('🗑️ Cleared cached organization for:', email);
  } catch (error) {
    console.error('Error clearing cached organization:', error);
  }
}

/**
 * Clear all cached organization data
 */
export function clearAllCachedOrganizations() {
  try {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(CACHE_KEY_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
    console.log('🗑️ Cleared all cached organizations');
  } catch (error) {
    console.error('Error clearing all cached organizations:', error);
  }
}

/**
 * Get the most recently used organization (for showing default logo)
 */
export function getMostRecentOrganization(): CachedOrganization | null {
  try {
    const keys = Object.keys(localStorage);
    const orgCaches: CachedOrganization[] = [];
    
    keys.forEach(key => {
      if (key.startsWith(CACHE_KEY_PREFIX)) {
        try {
          const cached = localStorage.getItem(key);
          if (cached) {
            const data: CachedOrganization = JSON.parse(cached);
            // Check if not expired
            const cachedDate = new Date(data.cached_at);
            const now = new Date();
            const daysDiff = (now.getTime() - cachedDate.getTime()) / (1000 * 60 * 60 * 24);
            if (daysDiff <= CACHE_EXPIRY_DAYS) {
              orgCaches.push(data);
            }
          }
        } catch (e) {
          // Skip invalid cache entries
        }
      }
    });
    
    if (orgCaches.length === 0) return null;
    
    // Sort by cached_at (most recent first)
    orgCaches.sort((a, b) => 
      new Date(b.cached_at).getTime() - new Date(a.cached_at).getTime()
    );
    
    return orgCaches[0];
  } catch (error) {
    console.error('Error getting most recent organization:', error);
    return null;
  }
}

