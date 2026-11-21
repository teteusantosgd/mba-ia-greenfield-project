import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'video_owner@example.com', password: 'hashed' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Owner', nickname: 'owner', user_id: user.id });
  });

  function buildVideo(overrides: Partial<Video> = {}): Partial<Video> {
    const id = randomUUID();
    return {
      id,
      public_id: id.slice(0, 11),
      channel_id: channel.id,
      title: 'aula',
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      source_key: `videos/${id}/source`,
      ...overrides,
    };
  }

  it('starts as draft when no status is given', async () => {
    const { id } = await videoRepository.save(buildVideo());

    const stored = await videoRepository.findOneByOrFail({ id });
    expect(stored.status).toBe(VideoStatus.DRAFT);
  });

  it('rejects a second video with the same public_id', async () => {
    await videoRepository.save(buildVideo({ public_id: 'sameId12345' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'sameId12345' })),
    ).rejects.toThrow(/UQ_videos_public_id/);
  });

  it('rejects a status outside the enum', async () => {
    await expect(
      videoRepository.save(buildVideo({ status: 'deleted' as VideoStatus })),
    ).rejects.toThrow(/video_status/);
  });

  it('reads size_bytes above 2^32 back as a number', async () => {
    const size = 10 * 1024 ** 3;
    const { id } = await videoRepository.save(buildVideo({ size_bytes: size }));

    const stored = await videoRepository.findOneByOrFail({ id });
    expect(stored.size_bytes).toBe(size);
  });

  it('is removed together with its channel', async () => {
    const { id } = await videoRepository.save(buildVideo());

    await dataSource.getRepository(Channel).delete(channel.id);

    expect(await videoRepository.findOneBy({ id })).toBeNull();
  });
});
