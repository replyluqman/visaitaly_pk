/**
 * Schema barrel. Drizzle needs every table registered here for relational
 * queries and for `drizzle(client, { schema })` to type correctly.
 * A new table file that is not exported here is invisible to the ORM.
 */
export * from './users.js';
export * from './devices.js';
export * from './app-config.js';
export * from './relationships.js';
export * from './legal.js';
export * from './applicants.js';
