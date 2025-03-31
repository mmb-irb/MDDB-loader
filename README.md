## Requirements

Have Node.js and npm installed and working.

## Run script

`node index.js` or `./index.js`

A help menu will be displayed, please follow the instructions provided by the help

### `.env` file fields

⚠️ No sensible default value is provided for any of these fields, they **need to be defined** ⚠️

The DB user needs to have writing rights

| key              | value   | description                         |
| ---------------- | ------- | ----------------------------------- |
| DB_SERVER        | `<url>` | url of the db server                |
| DB_PORT          | number  | port of the db server               |
| DB_NAME          | string  | name of the db collection           |
| DB_AUTH_USER     | string  | db user                             |
| DB_AUTH_PASSWORD | string  | db password                         |
| DB_AUTHSOURCE    | string  | authentication db                   |
| ACCESSION_PREFIX | string  | prefix for the accession (ex: MCNS) |
