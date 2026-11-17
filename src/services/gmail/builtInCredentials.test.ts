import { getSetting, setSecureSetting, setSetting } from "../db/settings";
import { builtInGoogleCredentials, seedBuiltInGoogleCredentials } from "./builtInCredentials";

vi.mock("../db/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  setSecureSetting: vi.fn(),
}));

const ID = "123-abc.apps.googleusercontent.com";
const SECRET = "GOCSPX-abcdef";

describe("built-in Google credentials", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is absent when the build carried no client", () => {
    expect(builtInGoogleCredentials({})).toBeNull();
  });

  it("ignores a swapped or malformed value instead of seeding it", () => {
    expect(builtInGoogleCredentials({ VITE_GOOGLE_CLIENT_ID: SECRET })).toBeNull();
    expect(builtInGoogleCredentials({ VITE_GOOGLE_CLIENT_ID: ID, VITE_GOOGLE_CLIENT_SECRET: ID })).toBeNull();
  });

  it("seeds an empty install", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    const seeded = await seedBuiltInGoogleCredentials({
      VITE_GOOGLE_CLIENT_ID: ` ${ID} `,
      VITE_GOOGLE_CLIENT_SECRET: SECRET,
    });
    expect(seeded).toBe(true);
    expect(setSetting).toHaveBeenCalledWith("google_client_id", ID);
    expect(setSecureSetting).toHaveBeenCalledWith("google_client_secret", SECRET);
  });

  it("never overwrites a client entered in Settings", async () => {
    vi.mocked(getSetting).mockResolvedValue("999-mine.apps.googleusercontent.com");
    const seeded = await seedBuiltInGoogleCredentials({
      VITE_GOOGLE_CLIENT_ID: ID,
      VITE_GOOGLE_CLIENT_SECRET: SECRET,
    });
    expect(seeded).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
    expect(setSecureSetting).not.toHaveBeenCalled();
  });
});
