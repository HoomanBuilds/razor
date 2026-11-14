declare module "ed2curve" {
  const conversion: {
    convertPublicKey: (key: Uint8Array) => Uint8Array | null;
    convertSecretKey: (key: Uint8Array) => Uint8Array | null;
  };
  export default conversion;
}
