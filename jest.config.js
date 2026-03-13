/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@capture/(.*)$': '<rootDir>/src/capture/$1',
    '^@state/(.*)$': '<rootDir>/src/state/$1',
    '^@overlay/(.*)$': '<rootDir>/src/overlay/$1',
    '^@persistence/(.*)$': '<rootDir>/src/persistence/$1',
  },
};
