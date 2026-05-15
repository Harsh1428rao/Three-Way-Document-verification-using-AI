const express = require('express');
const router = express.Router();
const { getMatchByPONumber, listAllMatches } = require('../controllers/matchController');

// GET /match
router.get('/', listAllMatches);

// GET /match/:poNumber
router.get('/:poNumber', getMatchByPONumber);

module.exports = router;
