import { defineConfig } from 'sanity';
import { deskTool } from 'sanity/desk';
import { schemaTypes } from './schemas';

export default defineConfig({
  name: 'default',
  title: 'CryptoFlip Marketing Studio',

  projectId: process.env.SANITY_STUDIO_PROJECT_ID || 'cf_casino_proj',
  dataset: process.env.SANITY_STUDIO_DATASET || 'production',

  plugins: [deskTool()],

  schema: {
    types: schemaTypes,
  },
});
