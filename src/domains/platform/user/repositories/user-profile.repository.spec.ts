import type { DBExecutor } from "@/db/db.manager";
import { userProfileTable, userSportProfileTable } from "@/db/schema";

import { UserProfileRepository } from "./user-profile.repository";

const makeExecutor = (
  targetProfile: Array<{ id: number }>,
  targetSportProfiles: Array<{ sport: "sailing" | "windsurf" }>,
) => {
  const profileLimit = jest.fn().mockResolvedValue(targetProfile);
  const profileWhere = jest.fn().mockReturnValue({ limit: profileLimit });
  const sportWhere = jest.fn().mockResolvedValue(targetSportProfiles);
  const select = jest
    .fn()
    .mockReturnValueOnce({
      from: jest.fn().mockReturnValue({ where: profileWhere }),
    })
    .mockReturnValueOnce({
      from: jest.fn().mockReturnValue({ where: sportWhere }),
    });

  const deleteWhere = jest.fn().mockResolvedValue(undefined);
  const deleteRows = jest.fn().mockReturnValue({ where: deleteWhere });
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const setOwner = jest.fn().mockReturnValue({ where: updateWhere });
  const updateRows = jest.fn().mockReturnValue({ set: setOwner });

  return {
    executor: {
      select,
      delete: deleteRows,
      update: updateRows,
    } as unknown as DBExecutor,
    deleteRows,
    updateRows,
    setOwner,
  };
};

describe("UserProfileRepository.mergeIntoExistingAccount", () => {
  const repository = new UserProfileRepository();

  it("keeps target preferences and removes colliding anonymous rows", async () => {
    const { executor, deleteRows, updateRows, setOwner } = makeExecutor(
      [{ id: 20 }],
      [{ sport: "sailing" }],
    );

    await repository.mergeIntoExistingAccount(1, 2, executor);

    expect(deleteRows).toHaveBeenNthCalledWith(1, userProfileTable);
    expect(deleteRows).toHaveBeenNthCalledWith(2, userSportProfileTable);
    // Non-colliding anonymous sport rows still fill gaps on the target.
    expect(updateRows).toHaveBeenCalledTimes(1);
    expect(updateRows).toHaveBeenCalledWith(userSportProfileTable);
    expect(setOwner).toHaveBeenCalledWith({ userId: 2 });
  });

  it("moves anonymous preferences when the target has none", async () => {
    const { executor, deleteRows, updateRows, setOwner } = makeExecutor([], []);

    await repository.mergeIntoExistingAccount(1, 2, executor);

    expect(deleteRows).not.toHaveBeenCalled();
    expect(updateRows).toHaveBeenNthCalledWith(1, userProfileTable);
    expect(updateRows).toHaveBeenNthCalledWith(2, userSportProfileTable);
    expect(setOwner).toHaveBeenNthCalledWith(1, { userId: 2 });
    expect(setOwner).toHaveBeenNthCalledWith(2, { userId: 2 });
  });
});
