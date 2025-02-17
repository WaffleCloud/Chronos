// NPM package that gathers health information
const si = require('systeminformation');
const { Client } = require('pg');
const alert = require('./alert');
const { kafkaFetch } = require('./kafkaHelpers');
const { collectHealthData } = require('./healthHelpers');

let client;

const chronos = {};

/**
 * Initializes connection to PostgreSQL database using provided URI
 * @param {Object} database Contains DB type and DB URI
 */
chronos.connect = async ({ database }) => {
  try {
    // Connect to user's database
    client = new Client({ connectionString: database.URI });
    await client.connect();

    // Print success message
    console.log('Connected to database at ', database.URI.slice(0, 24), '...');
  } catch ({ message }) {
    // Print error message
    console.log('Error connecting to PostgreSQL DB:', message);
  }
};

/**
 * Create services table with each entry representing a microservice
 * @param {string} microservice Microservice name
 * @param {number} interval Interval to collect data
 */
chronos.services = ({ microservice, interval }) => {
  // Create services table if does not exist
  client.query(
    `CREATE TABLE IF NOT EXISTS services (
      _id SERIAL PRIMARY KEY NOT NULL,
      microservice VARCHAR(248) NOT NULL UNIQUE,
      interval INTEGER NOT NULL
      )`,
    (err, results) => {
      if (err) {
        throw err;
      }
    }
  );

  // Insert microservice name and interval into services table
  const queryString = `
    INSERT INTO services (microservice, interval)
    VALUES ($1, $2)
    ON CONFLICT (microservice) DO NOTHING;`;

  const values = [microservice, interval];

  client.query(queryString, values, (err, result) => {
    if (err) {
      throw err;
    }
    console.log(`Microservice "${microservice}" recorded in services table`);
  });
};

/**
 * Creates a communications table if one does not yet exist and
 * traces the request throughout its life cycle. Will send a notification
 * to the user if contact information is provided
 * @param {string} microservice Microservice name
 * @param {Object|undefined} slack Slack settings
 * @param {Object|undefined} email Email settings
 */
chronos.communications = ({ microservice, slack, email }) => {
  // Create communications table if one does not exist
  client.query(
    `CREATE TABLE IF NOT EXISTS communications(
    _id serial PRIMARY KEY,
    microservice VARCHAR(248) NOT NULL,
    endpoint varchar(248) NOT NULL,
    request varchar(16) NOT NULL,
    responsestatus INTEGER NOT NULL,
    responsemessage varchar(500) NOT NULL,
    time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    correlatingId varchar(500)
  )`,
    (err, results) => {
      if (err) {
        throw err;
      }
    }
  );
  return (req, res, next) => {
    // ID persists throughout request lifecycle
    const correlatingId = res.getHeaders()['x-correlation-id'];

    // Target endpoint
    const endpoint = req.originalUrl;

    // HTTP Request Method
    const request = req.method;

    const queryString = `
      INSERT INTO communications (microservice, endpoint, request, responsestatus, responsemessage, correlatingId)
      VALUES ($1, $2, $3, $4, $5, $6);`;

    // Waits for response to finish before pushing information into database
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        if (slack) alert.sendSlack(res.statusCode, res.statusMessage, slack);
        if (email) alert.sendEmail(res.statusCode, res.statusMessage, email);
      }
      // Grabs status code from response object
      const responsestatus = res.statusCode;
      // Grabs status message from response object
      const responsemessage = res.statusMessage;
      const values = [
        microservice,
        endpoint,
        request,
        responsestatus,
        responsemessage,
        correlatingId,
      ];
      client.query(queryString, values, (err, result) => {
        if (err) {
          throw err;
        }
        console.log('Request cycle saved');
      });
    });
    next();
  };
};

// Constructs a parameterized query string for inserting multiple data points into
// the kafkametrics db based on the number of data points;
function createQueryString(numRows, serviceName) {
  let query = `
    INSERT INTO
      ${serviceName} (metric, value, category, time)
    VALUES
  `;
  for (let i = 0; i < numRows; i++) {
    const newRow = `($${4 * i + 1}, $${4 * i + 2}, $${4 * i + 3}, TO_TIMESTAMP($${4 * i + 4}))`;
    query = query.concat(newRow);
    if (i !== numRows - 1) query = query.concat(',');
  }
  query = query.concat(';');
  return query;
}

// Places the values being inserted into postgres into an array that will eventually
// hydrate the parameterized query
function createQueryArray(dataPointsArray) {
  const queryArray = [];
  for (const element of dataPointsArray) {
    queryArray.push(element.metric);
    queryArray.push(element.value);
    queryArray.push(element.category);
    queryArray.push(element.time / 1000); // Converts milliseconds to seconds to work with postgres
  }
  return queryArray;
}

/**
 * Read and store microservice health information in postgres database at every interval
 * @param {string} microservice Microservice name
 * @param {number} interval Interval for continuous data collection
 */
chronos.health = ({ microservice, interval }) => {
  // Create table for the microservice if it doesn't exist yet
  // create kafkametrics table if it does not exist
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS ${microservice} (
      _id SERIAL PRIMARY KEY,
      metric VARCHAR(200),
      value FLOAT DEFAULT 0.0,
      category VARCHAR(200) DEFAULT 'event',
      time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;

  client
    .query(createTableQuery)
    .catch(err => console.log('Error creating kafkametrics table in PostgreSQL:\n', err));

  // Save data point at every interval (ms)
  setInterval(() => {
    collectHealthData()
      .then(data => {
        const numRows = data.length;
        const queryString = createQueryString(numRows, microservice);
        const queryArray = createQueryArray(data);
        // console.log('POSTGRES QUERY STRING: ', queryString);
        // console.log('POSTGRES QUERY ARRAY', queryArray);
        return client.query(queryString, queryArray);
      })
      .then(() => console.log('Health data recorded in PostgreSQL'))
      .catch(err => console.log('Error inserting health data into PostgreSQL:\n', err));
  }, interval);
};

/**
 * Runs instead of health
 * If dockerized is true, this function is invoked
 * Collects information on the container
 */
chronos.docker = function ({ microservice, interval }) {
  // Create a table if it doesn't already exist.
  client.query(
    'CREATE TABLE IF NOT EXISTS containerInfo(\n    _id serial PRIMARY KEY,\n    microservice varchar(500) NOT NULL,\n    containerName varchar(500) NOT NULL,\n    containerId varchar(500) NOT NULL,\n    containerPlatform varchar(500),\n    containerStartTime varchar(500),\n    containerMemUsage real DEFAULT 0,\n    containerMemLimit real DEFAULT 0,\n    containerMemPercent real DEFAULT 0,\n    containerCpuPercent real DEFAULT 0,\n    networkReceived real DEFAULT 0,\n    networkSent real DEFAULT 0,\n    containerProcessCount integer DEFAULT 0,\n    containerRestartCount integer DEFAULT 0\n    )',
    function (err, results) {
      if (err) throw err;
    }
  );
  // Declare vars that represent columns in postgres and will be reassigned with values retrieved by si.
  var containerName;
  var containerPlatform;
  var containerStartTime;
  var containerMemUsage;
  var containerMemLimit;
  var containerMemPercent;
  var containerCpuPercent;
  var networkReceived;
  var networkSent;
  var containerProcessCount;
  var containerRestartCount;
  // dockerContainers() return an arr of active containers (ea. container = an obj).
  // Find the data pt with containerName that matches microservice name.
  // Extract container ID, name, platform, and start time.
  // Other stats will be retrieved by dockerContainerStats().
  si.dockerContainers()
    .then(function (data) {
      var containerId = '';

      for (var _i = 0, data_1 = data; _i < data_1.length; _i++) {
        var dataObj = data_1[_i];
        if (dataObj.name === microservice) {
          containerName = dataObj.name;
          containerId = dataObj.id;
          containerPlatform = dataObj.platform;
          containerStartTime = dataObj.startedAt;
          // End iterations as soon as the matching data pt is found.
          break;
        }
      }
      // When containerId has a value:
      // Initiate periodic invoc. of si.dockerContainerStats to retrieve and log stats to DB.
      // The desired data pt is the first obj in the result array.
      if (containerId !== '') {
        setInterval(function () {
          si.dockerContainerStats(containerId)
            .then(function (data) {
              // console.log('data[0] of dockerContainerStats', data[0]);
              // Reassign other vars to the values from retrieved data.
              // Then save to DB.
              containerMemUsage = data[0].mem_usage;
              containerMemLimit = data[0].mem_limit;
              containerMemPercent = data[0].mem_percent;
              containerCpuPercent = data[0].cpu_percent;
              networkReceived = data[0].netIO.rx;
              networkSent = data[0].netIO.wx;
              containerProcessCount = data[0].pids;
              containerRestartCount = data[0].restartCount;
              var queryString =
                'INSERT INTO containerInfo(\n                microservice,\n                containerName,\n                containerId,\n                containerPlatform,\n                containerStartTime,\n                containerMemUsage,\n                containerMemLimit,\n                containerMemPercent,\n                containerCpuPercent,\n                networkReceived,\n                networkSent,\n                containerProcessCount,\n                containerRestartCount)\n                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13\n              )';
              var values = [
                microservice,
                containerName,
                containerId,
                containerPlatform,
                containerStartTime,
                containerMemUsage,
                containerMemLimit,
                containerMemPercent,
                containerCpuPercent,
                networkReceived,
                networkSent,
                containerProcessCount,
                containerRestartCount,
              ];
              client.query(queryString, values, function (err, results) {
                if (err) throw err;
                console.log('Saved to SQL!');
              });
            })
            ['catch'](function (err) {
              throw err;
            });
        }, interval);
      } else {
        throw new Error('Cannot find container data matching the microservice name.');
      }
    })
    ['catch'](function (err) {
      throw err;
    });
};

chronos.kafka = function (userConfig) {
  // Ensure that kafkametrics are a part of the services table
  chronos.services({ microservice: 'kafkametrics', interval: userConfig.interval });
  // create kafkametrics table if it does not exist
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS kafkametrics (
      _id SERIAL PRIMARY KEY,
      metric VARCHAR(200),
      value FLOAT DEFAULT 0.0,
      category VARCHAR(200) DEFAULT 'event',
      time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;

  client
    .query(createTableQuery)
    .catch(err => console.log('Error creating kafkametrics table in PostgreSQL:\n', err));

  setInterval(() => {
    kafkaFetch(userConfig)
      .then(parsedArray => {
        const numDataPoints = parsedArray.length;
        const queryString = createQueryString(numDataPoints, 'kafkametrics');
        const queryArray = createQueryArray(parsedArray);
        return client.query(queryString, queryArray);
      })
      .then(() => console.log('Kafka metrics recorded in PostgreSQL'))
      .catch(err => console.log('Error inserting kafka metrics into PostgreSQL:\n', err));
  }, userConfig.interval);
};

module.exports = chronos;
