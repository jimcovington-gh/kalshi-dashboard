"""
Voiceprint Clips API - Curation interface for speaker voiceprint clips.

Endpoints:
- GET /voiceprint/speakers          - List all speakers with clip counts
- GET /voiceprint/clips?speaker=X   - List clips for a speaker (with presigned URLs)
- POST /voiceprint/clips/{clip_id}/status - Update clip status (approve/reject)
- GET /voiceprint/clips/{clip_id}/url     - Get presigned URL for a clip
"""

import json
import os
import boto3
from decimal import Decimal
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
s3_client = boto3.client('s3', region_name='us-east-1')

CLIPS_TABLE = os.environ.get('VOICEPRINT_CLIPS_TABLE', 'production-kalshi-voiceprint-clips')
LIBRARY_BUCKET = os.environ.get('VOICEPRINT_LIBRARY_BUCKET', 'production-kalshi-voiceprint-library')

table = dynamodb.Table(CLIPS_TABLE)


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        },
        'body': json.dumps(body, cls=DecimalEncoder),
    }


def generate_presigned_url(s3_key, expires_in=3600):
    """Generate a presigned URL for an S3 object."""
    return s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': LIBRARY_BUCKET, 'Key': s3_key},
        ExpiresIn=expires_in,
    )


def list_speakers():
    """List all speakers with clip counts by status."""
    result = table.scan(
        ProjectionExpression='speaker, #s',
        ExpressionAttributeNames={'#s': 'status'},
    )
    items = result.get('Items', [])
    while 'LastEvaluatedKey' in result:
        result = table.scan(
            ProjectionExpression='speaker, #s',
            ExpressionAttributeNames={'#s': 'status'},
            ExclusiveStartKey=result['LastEvaluatedKey'],
        )
        items.extend(result.get('Items', []))

    speakers = {}
    for item in items:
        name = item['speaker']
        status = item.get('status', 'candidate')
        if name not in speakers:
            speakers[name] = {'speaker': name, 'candidate': 0, 'approved': 0, 'rejected': 0, 'total': 0}
        speakers[name][status] = speakers[name].get(status, 0) + 1
        speakers[name]['total'] += 1

    return response(200, {'speakers': sorted(speakers.values(), key=lambda x: x['speaker'])})


def list_clips(speaker):
    """List all clips for a speaker with presigned URLs."""
    result = table.query(
        KeyConditionExpression=Key('speaker').eq(speaker),
    )
    items = result.get('Items', [])

    for item in items:
        if item.get('s3_key'):
            item['audio_url'] = generate_presigned_url(item['s3_key'])

    # Sort: candidates first, then approved, then rejected
    status_order = {'candidate': 0, 'approved': 1, 'rejected': 2}
    items.sort(key=lambda x: (status_order.get(x.get('status', 'candidate'), 9), x.get('clip_id', '')))

    return response(200, {'speaker': speaker, 'clips': items})


def update_clip_status(speaker, clip_id, new_status):
    """Update a clip's status (candidate -> approved/rejected)."""
    if new_status not in ('approved', 'rejected', 'candidate'):
        return response(400, {'error': f'Invalid status: {new_status}. Must be approved, rejected, or candidate.'})

    table.update_item(
        Key={'speaker': speaker, 'clip_id': clip_id},
        UpdateExpression='SET #s = :status',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={':status': new_status},
    )

    return response(200, {'speaker': speaker, 'clip_id': clip_id, 'status': new_status})


def get_clip_url(speaker, clip_id):
    """Get a presigned URL for a specific clip."""
    result = table.get_item(Key={'speaker': speaker, 'clip_id': clip_id})
    item = result.get('Item')
    if not item:
        return response(404, {'error': 'Clip not found'})

    if not item.get('s3_key'):
        return response(404, {'error': 'Clip has no audio file'})

    url = generate_presigned_url(item['s3_key'])
    return response(200, {'url': url, 'clip_id': clip_id})


def lambda_handler(event, context):
    method = event.get('httpMethod', '')
    path = event.get('path', '')
    params = event.get('queryStringParameters') or {}
    path_params = event.get('pathParameters') or {}

    # GET /voiceprint/speakers
    if method == 'GET' and path == '/voiceprint/speakers':
        return list_speakers()

    # GET /voiceprint/clips?speaker=X
    if method == 'GET' and path == '/voiceprint/clips':
        speaker = params.get('speaker')
        if not speaker:
            return response(400, {'error': 'speaker parameter required'})
        return list_clips(speaker)

    # POST /voiceprint/clips/{clip_id}/status
    if method == 'POST' and '/status' in path:
        clip_id = path_params.get('clip_id', '')
        raw_body = event.get('body', '{}')
        body = json.loads(raw_body) if isinstance(raw_body, str) else (raw_body or {})
        speaker = body.get('speaker')
        new_status = body.get('status')
        if not speaker or not new_status:
            return response(400, {'error': 'speaker and status required in body'})
        return update_clip_status(speaker, clip_id, new_status)

    # GET /voiceprint/clips/{clip_id}/url
    if method == 'GET' and '/url' in path:
        clip_id = path_params.get('clip_id', '')
        speaker = params.get('speaker')
        if not speaker:
            return response(400, {'error': 'speaker parameter required'})
        return get_clip_url(speaker, clip_id)

    return response(404, {'error': f'Not found: {method} {path}'})
