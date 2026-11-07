// Sends one test notification from Jarvis. Run with: node scripts/test-notify.js
import { notify } from '../src/notify.js';

notify({ title: 'Jarvis: δοκιμή', body: 'Αν βλέπεις αυτό, οι ειδοποιήσεις δουλεύουν!' });
