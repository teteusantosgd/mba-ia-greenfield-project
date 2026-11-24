import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import {
  PartUrlsResponseDto,
  UploadStatusResponseDto,
} from './dto/upload-response.dto';
import {
  StartUploadResponseDto,
  toStartUploadResponse,
  toVideoResponse,
  VideoResponseDto,
} from './dto/video-response.dto';
import { PART_SIZE_BYTES, PART_URL_TTL_SECONDS } from './videos.constants';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

const signedRedirect = {
  status: 302,
  description: 'Redirect to a signed storage URL, valid for 2 hours',
  headers: {
    Location: { description: 'Signed storage URL', schema: { type: 'string' } },
  },
};

// Uploads issue one request per batch of parts, far above the auth limit.
@SkipThrottle()
@ApiTags('videos')
@ApiBearerAuth('access-token')
@ApiResponse({
  status: 401,
  description: 'Missing or invalid token',
  schema: errorSchema,
})
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Creates the video as a draft in the caller channel and opens a multipart upload. ' +
      'The client then asks for part URLs and sends the parts straight to the storage.',
  })
  @ApiResponse({ status: 201, type: StartUploadResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  async startUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<StartUploadResponseDto> {
    const video = await this.videosService.startUpload(user.sub, dto);
    return toStartUploadResponse(video);
  }

  @Post(':id/upload/part-urls')
  @ApiOperation({
    summary: 'Sign upload URLs for video parts',
    description:
      'Returns one presigned PUT URL per requested part. Each URL only accepts a body of the listed size.',
  })
  @ApiResponse({ status: 201, type: PartUrlsResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already completed',
    schema: errorSchema,
  })
  async signPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: RequestPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    const parts = await this.videosService.signPartUrls(
      user.sub,
      id,
      dto.part_numbers,
    );
    return {
      urls: parts.map(({ partNumber, size, url }) => ({
        part_number: partNumber,
        size,
        url,
      })),
      expires_in: PART_URL_TTL_SECONDS,
    };
  }

  @Get(':id/upload')
  @ApiOperation({
    summary: 'Get upload progress',
    description:
      'Lists the parts the storage already has, so an interrupted upload can resume.',
  })
  @ApiResponse({ status: 200, type: UploadStatusResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Upload already completed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 410,
    description: 'Upload session expired',
    schema: errorSchema,
  })
  async getUploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<UploadStatusResponseDto> {
    const { partCount, parts } = await this.videosService.getUploadStatus(
      user.sub,
      id,
    );
    return {
      part_size: PART_SIZE_BYTES,
      part_count: partCount,
      uploaded_parts: parts.map(({ partNumber, size }) => ({
        part_number: partNumber,
        size,
      })),
    };
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Assembles the parts, moves the video to processing and enqueues it. ' +
      'Calling it again returns the current state.',
  })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Parts missing or with the wrong size',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 410,
    description: 'Upload session expired',
    schema: errorSchema,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.completeUpload(user.sub, id);
    return toVideoResponse(video);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a video' })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findOwnedVideo(user.sub, id);
    return toVideoResponse(video);
  }

  @Get(':id/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'The storage answers Range requests with 206, so players can seek.',
  })
  @ApiResponse(signedRedirect)
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: errorSchema,
  })
  async stream(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { url: await this.videosService.getStreamUrl(user.sub, id) };
  }

  @Get(':id/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download the original file',
    description:
      'The signed URL makes the storage reply with Content-Disposition: attachment.',
  })
  @ApiResponse(signedRedirect)
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: errorSchema,
  })
  async download(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { url: await this.videosService.getDownloadUrl(user.sub, id) };
  }

  @Get(':id/thumbnail')
  @Redirect()
  @ApiOperation({ summary: 'Get the video thumbnail (JPEG)' })
  @ApiResponse(signedRedirect)
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: errorSchema,
  })
  async thumbnail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return { url: await this.videosService.getThumbnailUrl(user.sub, id) };
  }
}
