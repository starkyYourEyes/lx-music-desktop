declare module 'crypto-js' {
  const CryptoJS: {
    SHA256: (message: string) => { toString: () => string }
  }
  export default CryptoJS
}
