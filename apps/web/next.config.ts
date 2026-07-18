import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@lagshield/core'],
};

export default nextConfig;
