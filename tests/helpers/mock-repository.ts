/**
 * Creates a typed mock of a repository/service class with the given methods as
 * `jest.fn()`s. Use in service specs to mock all dependencies.
 */
export function createMock<T>(methods: (keyof T)[]): jest.Mocked<T> {
  const mock: Record<string, jest.Mock> = {};
  for (const method of methods) {
    mock[method as string] = jest.fn();
  }
  return mock as unknown as jest.Mocked<T>;
}
