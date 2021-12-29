import {Greeter} from '../index';

test('My Greeter', () => {
  expect(Greeter('Kasper')).toBe('Hello Kasper');
});
