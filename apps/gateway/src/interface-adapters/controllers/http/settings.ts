/** The settings the HTTP controllers read. main/config.ts satisfies this shape; nothing here loads it. */
export interface HttpSettings {
  adminToken: string;
  /** lists the seeded demo accounts on the sign-in page */
  demoMode: boolean;
  /** the built console, served by frameworks/web */
  consoleDist: string;
  auth: {
    /** Express `trust proxy`: a hop count, true/false, or a subnet list */
    trustProxy: string;
    /** mark cookies Secure (and use the __Host- prefix) even when the request looks like plain HTTP */
    forceSecureCookies: boolean;
  };
}
