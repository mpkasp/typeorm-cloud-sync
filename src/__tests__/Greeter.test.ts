import { Greeter, SqliteStore } from '../index';

test('My Greeter', () => {
  expect(Greeter('Kasper')).toBe('Hello Kasper');
});

// TODO: Write a test that checks if we can tell that a SpecialUser is typeof User in Cloud-firebase User functions
test('Smoke', () => {
  // TODO !
  // const sqliteStore = new SqliteStore(connection);
});
