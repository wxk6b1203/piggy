export declare const PKG_ROOT: string;
export declare const OUT_FILE: string;
export declare function buildBridge(): Promise<string>;
export declare function isArtifactFresh(): Promise<{ fresh: true } | { fresh: false; reason: string }>;
