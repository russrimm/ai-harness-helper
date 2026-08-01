#!/usr/bin/env node
import { createEnvironment } from '@ai-harness-helper/core';

const env = createEnvironment();
console.log(`ai-harness-helper (platform: ${env.platform})`);
