const mongoose = require('mongoose');
const si = require('systeminformation');
const alert = require('./alert.js');
const CommunicationModel = require('../models/CommunicationModel');
const ServicesModel = require('../models/ServicesModel');
const HealthModelFunc = require('../models/HealthModel');
const ContainerInfoFunc = require('../models/ContainerInfo');
const KafkaModel = require('../models/KafkaModel');
const { kafkaFetch } = require('./kafkaHelpers.js');
const { collectHealthData } = require('./healthHelpers.js');
require('../models/ContainerInfo');

// Handle deprecation warnings
mongoose.set('useUnifiedTopology', true);
mongoose.set('useNewUrlParser', true);

const chronos = {};

/**
 * Initializes connection to MongoDB database using provided URI
 * @param {Object} database Contains DB type and DB URI
 */
chronos.connect = async ({ database }) => {
  console.log('Attemping to connect to database...');
  try {
    await mongoose.connect(`${database.URI}`);
    // Print success message
    console.log(`Chronos MongoDB is connected at ${database.URI.slice(0, 20)}...`);
  } catch ({ message }) {
    // Print error message
    console.log('Error connecting to MongoDB:', message);
  }
};

/**
 * Create services collection with each entry representing a microservice
 * @param {string} microservice Microservice name
 * @param {number} interval Interval to collect data
 */
chronos.services = ({ microservice, interval }) => {
  console.log(`Saving "${microservice}" to services...`);
  // Create newService object to store microservice information
  const newService = { microservice, interval };

  // Create MongoDB document from newService
  const service = new ServicesModel(newService);

  service
    .save()
    .then(() => console.log(`Added new service "${microservice}"`))
    .catch(err => console.log(`Error saving service "${microservice}": `, err.message));
};

/**
 * Creates a communications collection if one does not yet exist and
 * traces the request throughout its life cycle. Will send a notification
 * to the user if contact information is provided
 * @param {string} microservice Microservice name
 * @param {Object|undefined} slack Slack settings
 * @param {Object|undefined} email Email settings
 */
chronos.communications = ({ microservice, slack, email }) => {
  console.log('Recording request cycle...');

  return function (req, res, next) {
    // Setup newComms object to store data from each request
    const newComms = {
      microservice: microservice,
      endpoint: req.originalUrl,
      request: req.method,
      correlatingid: res.getHeaders()['x-correlation-id'],
    };

    res.on('finish', () => {
      /**
       * OPTIONAL FEATURE
       * If user provides contact information, send an alert if the
       * status code is over or equal to 400
       */
      if (res.statusCode >= 400) {
        if (slack) alert.sendSlack(res.statusCode, res.statusMessage, slack);
        if (email) alert.sendEmail(res.statusCode, res.statusMessage, email);
      }

      // Add status code and message to newComms
      newComms.responsestatus = res.statusCode;
      newComms.responsemessage = res.statusMessage;

      // Create MongoDB document from newComms
      const communication = new CommunicationModel(newComms);
      communication
        .save()
        .then(() => {
          console.log('Request cycle saved');
        })
        .catch(err => console.log(`Error saving communications: `, err.message));
    });

    // Call next middleware
    next();
  };
};

/**
 * Creates a new table per microservice which records all health data
 * @param {string} microservice Microservice name
 * @param {number} interval Interval for continuous data collection
 */
chronos.health = ({ microservice, interval }) => {
  setInterval(() => {
    collectHealthData()
      .then(healthMetrics => {
        // console.log('HEALTH METRICS: ', healthMetrics);
        const HealthModel = HealthModelFunc(`${microservice}`);
        return HealthModel.insertMany(healthMetrics);
      })
      .then(() => {
        console.log('Health data recorded in MongoDB');
      })
      .catch(err => console.log('Error inserting health documents: ', err));
  }, interval);
};

/**
 * Runs instead of health
 * If dockerized is true, this function is invoked
 * Collects information on the container
 */
chronos.docker = ({ microservice, interval }) => {
  // Declare vars that represent columns in postgres and will be reassigned with values retrieved by si.
  var containername;
  var platform;
  var starttime;
  var memoryusage;
  var memorylimit;
  var memorypercent;
  var cpupercent;
  var networkreceived;
  var networksent;
  var processcount;
  var restartcount;
  // dockerContainers() return an arr of active containers (ea. container = an obj).
  // Find the data pt with containerName that matches microservice.
  // Extract container ID, name, platform, and start time.
  // Other stats will be retrieved by dockerContainerStats().
  si.dockerContainers()
    .then(function (data) {
      var containerid = '';
      for (var _i = 0, data_1 = data; _i < data_1.length; _i++) {
        var dataObj = data_1[_i];
        if (dataObj.name === microservice) {
          containername = dataObj.name;
          containerid = dataObj.id;
          platform = dataObj.platform;
          starttime = dataObj.startedAt;
          // End iterations as soon as the matching data pt is found.
          break;
        }
      }
      // When containerId has a value:
      // Initiate periodic invoc. of si.dockerContainerStats to retrieve and log stats to DB.
      // The desired data pt is the first obj in the result array.
      if (containerid !== '') {
        setInterval(function () {
          si.dockerContainerStats(containerid)
            .then(function (data) {
              // console.log('data[0] of dockerContainerStats', data[0]);
              // Reassign other vars to the values from retrieved data.
              // Then save to DB.
              memoryusage = data[0].mem_usage;
              memorylimit = data[0].mem_limit;
              memorypercent = data[0].mem_percent;
              cpupercent = data[0].cpu_percent;
              networkreceived = data[0].netIO.rx;
              networksent = data[0].netIO.wx;
              processcount = data[0].pids;
              restartcount = data[0].restartCount;

              // Create collection using name of microservice
              const containerInfo = ContainerInfoFunc(`${containername}-containerinfo`);

              const newContainerInfo = new containerInfo({
                containerid,
                containername,
                platform,
                starttime,
                memoryusage,
                memorylimit,
                memorypercent,
                cpupercent,
                networkreceived,
                networksent,
                processcount,
                restartcount,
              });

              newContainerInfo
                .save()
                .then(() => console.log('Saved to MongoDB!'))
                .catch(err => console.log('Error saving container data: ', err.message));
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

/*
 This function takes as a parameter the promise returned from the kafkaFetch().
It then takes the returned array of metrics, turns them into documents based on
KafkaModel.js, and inserts them into the db at the provided uri with insertMany()
*/
chronos.kafka = function (userConfig) {
  // ensure that kafkametrics exists in the services table
  const service = new ServicesModel({
    microservice: 'kafkametrics',
    interval: userConfig.interval,
  });

  service
    .save()
    .then(() => console.log(`Adding "kafkametrics" to the services table`))
    .catch(err => console.log(`Error saving "kafkametrics" to the services table: `, err.message));

  // fetch the data from Kafka with kafkaFetch()
  // then take turn each result in the returned array into a kafkaModel doc
  // insertMany into the the KafkaModel
  setInterval(() => {
    kafkaFetch(userConfig)
      .then(parsedArray => {
        const documents = [];
        for (const metric of parsedArray) {
          documents.push(KafkaModel(metric));
        }
        return KafkaModel.insertMany(documents);
      })
      .then(() => console.log('Kafka metrics recorded in MongoDB'))
      .catch(err => console.log('Error inserting kafka documents in MongoDB: ', err));
  }, userConfig.interval);
};

module.exports = chronos;
