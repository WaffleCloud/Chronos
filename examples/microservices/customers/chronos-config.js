require('dotenv').config();
const chronos = require('chronos-tracker-7');

chronos.use({
  microservice: 'customers',
  interval: 2000,
  // dockerized: true,
  database: {
    connection: 'REST',
    type: 'MongoDB',
    URI: process.env.CHRONOS_URI,
  },
  notifications: [],
});
